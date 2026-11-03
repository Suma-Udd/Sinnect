// Demo mode: a fake session that behaves like a real one (streams text, calls
// tools, asks permission, hits file conflicts) without spending any tokens.
// Used for UI work, screenshots and trying the app without a login.

import path from 'node:path';
import { BaseSession, describeTool, newItemId } from './session.js';
import type { HubMessage } from './protocol.js';

const FILES = ['src/app.tsx', 'src/api/client.ts', 'src/styles.css', 'src/auth/login.ts', 'README.md', 'src/db/schema.ts'];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export class MockSession extends BaseSession {
  private run = 0;
  private freed: (() => void) | null = null;

  start() {
    this.state.sdkSessionId = `mock-${this.id}`;
    if (this.config.prompt.trim()) this.send(this.config.prompt);
    else this.setStatus('idle', 'Waiting for you');
  }

  protected pushInput(text: string) {
    const run = ++this.run;
    this.script(text, run).catch((e) => {
      this.feed('error', String(e), { isError: true });
      this.busy = false;
      this.setStatus('error', 'Mock crashed');
    });
  }

  private alive(run: number) {
    return !this.closed && run === this.run;
  }

  private tokens(input: number, output: number) {
    this.state.tokens.input += input;
    this.state.tokens.output += output;
    this.state.tokens.cacheRead += Math.round(input * 2.5);
    this.state.costUsd += (input * 3 + output * 15 + input * 2.5 * 0.3) / 1_000_000;
    this.publish();
  }

  private async stream(text: string, run: number) {
    const item = this.feed('text', '');
    this.setStatus('working', 'Writing a reply');
    const words = text.split(/(\s+)/);
    for (const w of words) {
      if (!this.alive(run)) return;
      this.host.feedDelta(this.id, item.id, w);
      if (w.trim()) this.tokens(0, 2);
      await sleep(18 + Math.random() * 40);
    }
  }

  private async useTool(name: string, input: Record<string, unknown>, result: string, run: number) {
    if (!this.alive(run)) return false;
    const line = describeTool(name, input);
    const toolUseId = newItemId();
    this.feed('tool', line, { toolName: name, toolUseId, input });
    this.setStatus('working', line);

    if (this.config.permission === 'ask' && name === 'Bash') {
      this.setStatus('waiting', `Needs your OK: ${name}`);
      const res = await this.host.ask({
        kind: 'tool',
        requestId: newItemId(),
        sessionId: this.id,
        toolName: name,
        title: `${this.config.name} wants to run a command`,
        detail: String(input.command),
        canAlwaysAllow: true,
      });
      if (!this.alive(run)) return false;
      if (res.kind === 'tool' && res.decision === 'deny') {
        this.feed('tool_result', 'The user said no.', { toolUseId, isError: true });
        this.setStatus('working', 'Changing plans');
        return false;
      }
      if (res.kind === 'tool' && res.decision === 'always') this.config.permission = 'acceptEdits';
      this.setStatus('working', line);
    }

    await sleep(500 + Math.random() * 900);
    if (!this.alive(run)) return false;
    this.feed('tool_result', result, { toolUseId });
    this.tokens(300 + Math.round(Math.random() * 900), 40);
    const notice = this.takeNoticeText();
    if (notice) this.feed('system', 'Read hub notices with the tool result');
    return true;
  }

  private async edit(file: string, run: number): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!this.alive(run)) return false;
      const abs = path.join(this.config.cwd, file);
      const reason = this.checkEdit('Edit', { file_path: abs });
      if (!reason) {
        await this.useTool('Edit', { file_path: abs, old_string: 'old', new_string: 'new' }, `Updated ${file}`, run);
        await sleep(1500 + Math.random() * 2500); // hold the claim a bit so conflicts can happen
        return true;
      }
      // Wait for a "free now" / "You got" notice, or give up after a while.
      await new Promise<void>((resolve) => {
        this.freed = resolve;
        setTimeout(resolve, 15000);
      });
      this.freed = null;
    }
    this.feed('text', `I'll leave ${file} for now since someone else is working on it.`);
    return false;
  }

  deliver(msg: HubMessage, wake: boolean) {
    super.deliver(msg, wake);
    if (/free now|You got/.test(msg.text)) this.freed?.();
    if (msg.kind === 'negotiation') {
      const m = /(neg_[a-z0-9]+)/.exec(msg.text);
      if (m) {
        const negId = m[1];
        setTimeout(() => {
          if (this.closed) return;
          const yieldIt = Math.random() < 0.5;
          const note = yieldIt ? "I'm nearly done there, go ahead" : 'I am mid-change, need a few more minutes';
          const toolUseId = newItemId();
          this.feed('tool', `Answering negotiation: ${yieldIt ? 'yield' : 'insist'}`, { toolName: 'mcp__murmur__hub_negotiate', toolUseId, input: { id: negId, note } });
          const out = this.host.hub.negotiate(this.id, negId, yieldIt ? 'yield' : 'insist', note);
          this.feed('tool_result', out, { toolUseId });
          this.tokens(120, 30);
        }, 1200 + Math.random() * 1500);
      }
    }
  }

  private async script(prompt: string, run: number) {
    const isHub = prompt.startsWith('[Murmur hub]');
    this.setStatus('thinking', 'Thinking');
    await sleep(700 + Math.random() * 900);
    if (!this.alive(run)) return;
    this.tokens(2400, 0);

    if (isHub) {
      await this.stream('Got the hub update. Picking things back up.', run);
      this.finish(run);
      return;
    }

    const topic = prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt;
    await this.stream(`On it. I'll start by looking around the project, then work on: ${topic}`, run);
    if (this.config.awareness !== 'solo') {
      this.setGoal(topic);
      await this.useTool('mcp__murmur__hub_set_status', { goal: topic }, 'Status updated.', run);
    }
    const files = [...FILES].sort(() => Math.random() - 0.5);
    await this.useTool('Glob', { pattern: 'src/**/*.ts*' }, files.join('\n'), run);
    await this.useTool('Read', { file_path: path.join(this.config.cwd, files[0]) }, '(file contents)', run);
    await this.useTool('Bash', { command: 'npm test', description: 'run the tests' }, '12 passing', run);

    await this.edit(files[0], run);
    if (Math.random() < 0.6) await this.edit(files[1], run);

    const peers = this.host.hub.visibleTo(this.id);
    if (peers.length && Math.random() < 0.7 && this.alive(run)) {
      const peer = pick(peers);
      const text = `Heads up: I changed ${files[0]}, re-read it before you touch it.`;
      const r = this.host.hub.send(this.id, peer.id, text);
      const toolUseId = newItemId();
      this.feed('tool', `Messaging ${peer.name}`, { toolName: 'mcp__murmur__hub_send', toolUseId, input: { to: peer.id, message: text } });
      this.feed('tool_result', r.ok ? 'Sent.' : r.error!, { toolUseId });
      this.tokens(200, 40);
    }

    await this.stream(`Done. I updated ${files[0]}${files[1] ? ` and looked at ${files[1]}` : ''}. Tell me if you want me to keep going.`, run);
    this.finish(run);
  }

  private finish(run: number) {
    if (!this.alive(run)) return;
    this.feed('result', 'Done');
    this.onTurnEnd();
  }

  async interrupt() {
    this.run++;
    this.feed('system', 'Interrupted');
    this.onTurnEnd();
  }

  protected async shutdown() {
    this.run++;
  }
}
