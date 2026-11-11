// Demo mode: a fake session that behaves like a real one (streams text, calls
// tools, asks permission, hits file conflicts) without spending any tokens.
// Used for UI work, screenshots and trying the app without a login.

import path from 'node:path';
import { BaseSession, describeTool, newItemId } from './session.js';
import type { HubMessage } from './protocol.js';
import { HELPERS_TAG } from './workers.js';

const FILES = ['src/app.tsx', 'src/api/client.ts', 'src/styles.css', 'src/auth/login.ts', 'README.md', 'src/db/schema.ts'];
const DEMO_LESSONS = [
  { type: 'rule', title: 'Run npm ci, never npm install', note: 'The lockfile is checked in and CI fails on drift. npm ci keeps it identical.' },
  { type: 'broke', title: 'Vite dev server breaks on port 5173', note: 'Something else on this machine holds 5173. Start it with --port 5180.' },
  { type: 'worked', title: 'Tests run fastest with --test-only', note: 'Mark the test you are fixing with test.only and run node --test --test-only, about 10x faster than the full suite.' },
  { type: 'rule', title: 'API types live in src/api/types.ts', note: 'Never redeclare response types in components, import them from src/api/types.ts so the client and UI stay in sync.' },
  { type: 'broke', title: 'Login test flakes without a fixed clock', note: 'login.test.ts compares token expiry. Freeze time with mock.timers or it fails around midnight.' },
];
const DEMO_SKILLS = [
  { name: 'Add an API endpoint', description: 'Adding a new REST endpoint end to end', steps: '1. Add the type to src/api/types.ts\n2. Add the route in src/api/routes.ts\n3. Add a client call in src/api/client.ts\n4. Write a test next to the route\n5. Run npm test' },
  { name: 'Release checklist', description: 'Before tagging a release', steps: '1. npm run typecheck\n2. npm test\n3. Bump the version with scripts/set-version.mjs\n4. Write release notes' },
];
const pickN = <T>(a: T[], n: number) => [...a].sort(() => Math.random() - 0.5).slice(0, n);
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
    if (!this.alive(run)) return;
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
          this.feed('tool', `Answering negotiation: ${yieldIt ? 'yield' : 'insist'}`, { toolName: 'mcp__sinnect__hub_negotiate', toolUseId, input: { id: negId, note } });
          const out = this.host.hub.negotiate(this.id, negId, yieldIt ? 'yield' : 'insist', note);
          this.feed('tool_result', out, { toolUseId });
          this.tokens(120, 30);
        }, 1200 + Math.random() * 1500);
      }
    }
  }

  private async script(prompt: string, run: number) {
    const isHub = prompt.startsWith('[Sinnect hub]');
    this.setStatus('thinking', 'Thinking');
    await sleep(700 + Math.random() * 900);
    if (!this.alive(run)) return;
    this.tokens(2400, 0);

    if (prompt.startsWith('[Sinnect memory]')) {
      this.setStatus('working', 'Writing down what it learned');
      const lessons = pickN(DEMO_LESSONS, 2 + Math.floor(Math.random() * 2));
      const skill = Math.random() < 0.6 ? [pick(DEMO_SKILLS)] : [];
      await this.stream('```json\n' + JSON.stringify({ lessons, skills: skill }, null, 1) + '\n```', run);
      this.finish(run);
      return;
    }

    if (this.config.parentId) return this.workerScript(prompt, run);
    if (prompt.startsWith(HELPERS_TAG)) return this.bossWrapUp(prompt, run);
    if (!isHub && this.state.turns === 0 && this.host.canSpawn(this.id) && /helper|team|worker|parallel|split|spawn/i.test(prompt)) return this.bossScript(prompt, run);

    if (isHub) {
      await this.stream('Got the hub update. Picking things back up.', run);
      this.finish(run);
      return;
    }

    const topic = prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt;
    await this.stream(`On it. I'll start by looking around the project, then work on: ${topic}`, run);
    if (this.config.awareness !== 'solo') {
      this.setGoal(topic);
      await this.useTool('mcp__sinnect__hub_set_status', { goal: topic }, 'Status updated.', run);
    }
    if (this.state.turns === 0 && Math.random() < 0.4) {
      this.setStatus('waiting', 'Asking you something');
      this.feed('tool', 'Asking you something', { toolName: 'AskUserQuestion' });
      const res = await this.host.ask({
        kind: 'question',
        requestId: newItemId(),
        sessionId: this.id,
        questions: [
          {
            question: 'Which styling approach should I use?',
            header: 'Styling',
            options: [
              { label: 'Tailwind', description: 'Utility classes, fast to iterate' },
              { label: 'CSS modules', description: 'Plain CSS scoped per component' },
            ],
          },
        ],
      });
      if (!this.alive(run)) return;
      const answer = res.kind === 'question' && !res.skipped ? Object.values(res.answers)[0] : null;
      await this.stream(answer ? `Got it, going with ${answer}.` : "No worries, I'll pick something sensible.", run);
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
      this.feed('tool', `Messaging ${peer.name}`, { toolName: 'mcp__sinnect__hub_send', toolUseId, input: { to: peer.id, message: text } });
      this.feed('tool_result', r.ok ? 'Sent.' : r.error!, { toolUseId });
      this.tokens(200, 40);
    }

    await this.stream(
      [
        `## Done`,
        ``,
        `I updated \`${files[0]}\`${files[1] ? ` and looked at \`${files[1]}\`` : ''}. Here's the short version:`,
        ``,
        `| File | Change |`,
        `| --- | --- |`,
        `| \`${files[0]}\` | **edited** |`,
        files[1] ? `| \`${files[1]}\` | read only |` : '',
        ``,
        `- Kept the change small`,
        `- Nothing else touched`,
        ``,
        `Tell me if you want me to keep going.`,
      ].join('\n'),
      run,
    );
    this.finish(run);
  }

  /** Demo boss: splits the job into helpers and lets them run in the background ("wait" in the prompt blocks instead). */
  private async bossScript(prompt: string, run: number) {
    const wait = /\bwait\b/i.test(prompt);
    await this.stream("Splitting this up so it goes faster. I'll send helpers to dig in and read their reports.", run);
    const workers = [
      { task: 'Find every place the checkout total is calculated and list file:line for each', kind: 'search' },
      { task: 'Run the test suite and report which tests fail and why', kind: 'test' },
      { task: 'Fix the rounding bug in src/cart/total.ts so totals use cents, not floats', kind: 'code' },
    ];
    const toolUseId = newItemId();
    const input = wait ? { workers, wait } : { workers };
    this.feed('tool', describeTool('mcp__sinnect__spawn_workers', input), { toolName: 'mcp__sinnect__spawn_workers', toolUseId, input });
    this.setStatus('working', describeTool('mcp__sinnect__spawn_workers', input));
    const out = await this.host.spawnWorkers(this.id, workers as never, { wait });
    if (!this.alive(run)) return;
    this.feed('tool_result', out, { toolUseId });
    this.tokens(1800, 60);
    if (wait) return this.bossWrapUp(prompt, run);
    await this.stream("Helpers are on it. I'll pick it back up when they report, you can keep talking to me meanwhile.", run);
    this.finish(run);
  }

  /** Demo boss, second half: the helper summaries are in. */
  private async bossWrapUp(_prompt: string, run: number) {
    await this.stream(
      ['## Done', '', 'My helpers covered it:', '', '- **Search** found the 3 places totals are computed', '- **Tests** showed 2 failing cart tests', '- **Code** switched totals to integer cents, tests pass now'].join('\n'),
      run,
    );
    this.finish(run);
  }

  /** Demo helper: a couple of quick tool calls, then one short summary. */
  private async workerScript(_prompt: string, run: number) {
    const kind = this.config.workerKind ?? 'code';
    if (kind === 'search' || kind === 'read' || kind === 'review' || kind === 'plan') {
      await this.useTool('Grep', { pattern: 'total' }, 'src/cart/total.ts:18\nsrc/checkout/summary.tsx:42\nsrc/api/orders.ts:77', run);
      await this.useTool('Read', { file_path: path.join(this.config.cwd, 'src/cart/total.ts') }, '(file contents)', run);
      await this.stream('Totals are computed in 3 places: `src/cart/total.ts:18` (main), `src/checkout/summary.tsx:42` (display, recomputes with floats), `src/api/orders.ts:77` (server). The UI one should call the cart helper instead.', run);
    } else if (kind === 'test') {
      await this.useTool('Bash', { command: 'npm test', description: 'run the tests' }, '2 failing\n  cart total rounds 0.1 + 0.2\n  discount applies once', run);
      await this.stream('2 of 48 tests fail: `cart total rounds 0.1 + 0.2` (float rounding in `total.ts:18`) and `discount applies once` (applied twice when the coupon is re-entered, `discount.ts:31`). Everything else passes.', run);
    } else {
      await this.useTool('Read', { file_path: path.join(this.config.cwd, 'src/cart/total.ts') }, '(file contents)', run);
      await this.edit('src/cart/total.ts', run);
      await this.useTool('Bash', { command: 'npm test -- cart', description: 'run the cart tests' }, '12 passing', run);
      await this.stream('Changed `src/cart/total.ts` to add up integer cents and only format at the end. Cart tests pass (12/12).', run);
    }
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
