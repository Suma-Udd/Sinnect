// An OpenAI session that runs on the user's ChatGPT plan. It drives OpenAI's
// own Codex app over its app-server protocol, the same way the Codex IDE
// extension does: Codex holds the ChatGPT login and runs the model, its own
// file and shell tools, and its own context compaction.
//
// Sinnect plugs in where the protocol lets a client plug in:
//  - its hub, memory and helper tools are passed in as Codex "dynamic tools",
//  - every command and file change comes to Sinnect for approval first, so the
//    permission setting, the dynamic island and file claims work like they do
//    for Claude sessions,
//  - hub notices that arrive mid-turn are steered into the running turn.

import path from 'node:path';
import { CodexClient, CodexRpcError, planUsage } from './codex.js';
import { LoopSession } from './loop-session.js';
import { openaiPrice } from './openai-session.js';
import { clip, describeTool, sinnectPrompt } from './session.js';

/** Codex's file and shell tools show on the card like Claude Code's. */
type Live = { feedId: string; kind: 'text' | 'thinking' };

const VERSION = process.env.npm_package_version ?? '0';

export class CodexSession extends LoopSession {
  protected readonly provider = 'codex';
  private rpc: CodexClient | null = null;
  private ready: Promise<void> | null = null;
  private threadId: string | null = null;
  private turnId: string | null = null;
  private turnStarted = 0;
  private live = new Map<string, Live>();
  /** Feed ids of tool items, so their results land under them. */
  private toolFeed = new Map<string, string>();
  /** File change items by id, so the approval knows which files they touch. */
  private changes = new Map<string, { path: string; diff?: string }[]>();
  /** Token totals for the thread when this session opened it (a resumed thread already has some). */
  private baseline: { input: number; cached: number; output: number } | null = null;
  private resumed = false;

  start() {
    const resume = this.config.resumeId?.startsWith('codex-') ? this.config.resumeId.slice(6) : null;
    this.resumed = !!resume;
    this.setStatus('starting', 'Starting Codex');
    this.ready = this.open(resume).catch((e) => {
      const msg = this.friendlyError(e);
      this.feed('error', msg, { isError: true });
      this.setStatus('error', clip(msg, 80));
      throw e;
    });
    this.ready
      .then(() => {
        if (this.config.prompt.trim()) this.send(this.config.prompt);
        else this.setStatus('idle', 'Waiting for you');
      })
      .catch(() => {});
  }

  private async open(resume: string | null) {
    const bin = this.host.codexBin?.() ?? null;
    if (!bin) throw new Error('Codex is not installed. Open Settings and install it to use your ChatGPT plan.');
    const rpc = new CodexClient(bin);
    this.rpc = rpc;
    rpc.onNotify = (m, p) => this.onNotify(m, p);
    rpc.onRequest = (m, p) => this.onRequest(m, p);
    rpc.onExit = (why) => this.onExit(why);
    await rpc.initialize(VERSION);
    const opts = {
      model: this.config.model,
      cwd: this.config.cwd,
      // Sinnect asks the user itself (or not, in Full auto), so every risky step comes to it.
      approvalPolicy: 'untrusted',
      sandbox: this.readOnly ? 'read-only' : 'danger-full-access',
      developerInstructions: sinnectPrompt(this.config, this.host.hub.roster(this.id), true, this.memoryBlock(), this.host.canSpawn(this.id)),
      dynamicTools: this.toolSpecs()
        .filter((t) => !FILE_TOOL_NAMES.has(t.name))
        .map((t) => ({ type: 'function', name: t.name, description: t.description, inputSchema: t.parameters })),
    };
    const r = resume ? await rpc.request('thread/resume', { threadId: resume, ...opts }) : await rpc.request('thread/start', opts);
    this.threadId = r.thread.id;
    this.state.sdkSessionId = `codex-${this.threadId}`;
    if (resume) {
      this.replay(r.thread.turns ?? []);
      this.feed('system', 'Resumed from your workspace');
    }
    this.publish();
  }

  // ---------- turns ----------

  protected async runTurn(text: string) {
    await this.ready;
    const rpc = this.rpc;
    if (!rpc || !this.threadId) throw new Error('Codex is not running');
    this.turnStarted = Date.now();
    const r = await rpc.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      // Helpers do small, well-described jobs, so they think less and use less of the plan.
      ...(this.config.parentId ? { effort: 'low' } : {}),
    });
    this.turnId = r.turn?.id ?? null;
    // The turn ends with the turn/completed notification.
  }

  /** Slip hub notices into the running turn, like the Claude hook does after each tool. */
  private steerNotices() {
    if (!this.rpc || !this.threadId || !this.turnId) return;
    const notice = this.takeNoticeText();
    if (!notice) return;
    this.rpc.request('turn/steer', { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: 'text', text: notice, text_elements: [] }] }).catch(() => {
      // The turn ended in between: the notice is lost from this turn, so queue it for the next one.
      this.queueTurn(notice, Math.max(1, this.turnDepth));
    });
  }

  private endTurn(turn: any) {
    if (!this.busy) return;
    this.turnId = null;
    this.live.clear();
    const status = turn?.status;
    if (status === 'failed' && turn?.error) this.feed('error', this.explain(turn.error), { isError: true });
    this.turnFinished(this.turnStarted);
    if (status === 'failed' && turn?.error) this.setStatus('idle', clip(this.explain(turn.error), 80));
  }

  // ---------- events from Codex ----------

  private onNotify(method: string, p: any) {
    if (p?.threadId && this.threadId && p.threadId !== this.threadId) return;
    switch (method) {
      case 'item/agentMessage/delta':
        return this.stream(p.itemId, 'text', p.delta);
      case 'item/reasoning/summaryTextDelta':
        return this.stream(`${p.itemId}:${p.summaryIndex ?? 0}`, 'thinking', p.delta);
      case 'item/started':
        return this.itemStarted(p.item);
      case 'item/completed':
        return this.itemCompleted(p.item);
      case 'thread/tokenUsage/updated':
        return this.count(p.tokenUsage);
      case 'turn/completed':
        return this.endTurn(p.turn);
      case 'error':
        if (!p?.willRetry && p?.error) this.feed('error', this.explain(p.error), { isError: true });
        else if (p?.error?.message) this.setStatus('working', clip(p.error.message, 60));
        return;
      case 'account/rateLimits/updated':
        this.host.planUsage?.(planUsage(p?.rateLimits));
        return;
    }
  }

  private stream(key: string, kind: 'text' | 'thinking', delta: string) {
    if (!delta) return;
    let l = this.live.get(key);
    if (!l) {
      l = { feedId: this.feed(kind, '').id, kind };
      this.live.set(key, l);
      this.setStatus(kind === 'thinking' ? 'thinking' : 'working', kind === 'thinking' ? 'Thinking' : 'Writing a reply');
    }
    this.host.feedDelta(this.id, l.feedId, delta);
  }

  private itemStarted(item: any) {
    if (!item) return;
    switch (item.type) {
      case 'commandExecution': {
        const input = { command: item.command, description: '' };
        this.toolFeed.set(item.id, this.feed('tool', describeTool('Bash', input), { toolName: 'Bash', toolUseId: item.id, input }).id);
        if (this.state.status !== 'waiting') this.setStatus('working', describeTool('Bash', input));
        return;
      }
      case 'fileChange': {
        const files = (item.changes ?? []) as { path: string; diff?: string; kind?: { type: string } }[];
        this.changes.set(item.id, files);
        const first = files[0];
        const toolName = first?.kind?.type === 'add' ? 'Write' : 'Edit';
        const input = { file_path: first?.path ?? '' };
        const line = files.length > 1 ? `Editing ${files.length} files` : describeTool(toolName, input);
        this.toolFeed.set(item.id, this.feed('tool', line, { toolName, toolUseId: item.id, input }).id);
        if (this.state.status !== 'waiting' && this.state.status !== 'blocked') this.setStatus('working', line);
        return;
      }
      case 'webSearch': {
        const input = { query: item.query ?? '' };
        this.feed('tool', describeTool('WebSearch', input), { toolName: 'WebSearch', input });
        this.setStatus('working', describeTool('WebSearch', input));
        return;
      }
      case 'mcpToolCall': {
        const name = `mcp__${item.server}__${item.tool}`;
        this.feed('tool', describeTool(name, {}), { toolName: name, input: item.arguments ?? {} });
        return;
      }
    }
  }

  private itemCompleted(item: any) {
    if (!item) return;
    if (item.type === 'commandExecution') {
      const out = `${item.aggregatedOutput ?? ''}`.trim() || '(no output)';
      this.feed('tool_result', clip(out + (item.exitCode ? `\n(exit code ${item.exitCode})` : ''), 4000), { toolUseId: item.id, isError: item.status === 'failed' || item.status === 'declined' });
    } else if (item.type === 'fileChange') {
      const files = (item.changes ?? []) as { path: string }[];
      for (const f of files) this.touch(f.path);
      this.feed('tool_result', item.status === 'completed' ? `Changed ${files.map((f) => path.basename(f.path)).join(', ')}` : `Not applied (${item.status})`, { toolUseId: item.id, isError: item.status !== 'completed' });
      this.changes.delete(item.id);
    } else if (item.type === 'agentMessage') {
      // Nothing was streamed for it (some replies arrive whole): show it now.
      if (item.text && !this.live.has(item.id)) this.feed('text', item.text);
      return;
    } else if (item.type === 'reasoning' || item.type === 'userMessage') {
      return;
    }
    // A tool step finished: this is where the Claude hook would slip notices in.
    this.steerNotices();
  }

  /** Approvals and tool calls. Whatever this returns goes back to Codex as the answer. */
  private async onRequest(method: string, p: any): Promise<unknown> {
    switch (method) {
      case 'item/commandExecution/requestApproval': {
        const input = { command: String(p.command ?? ''), description: p.reason ?? '' };
        const ok = await this.permit('Bash', input, 'shell');
        return { decision: ok.allow ? 'accept' : 'decline' };
      }
      case 'item/fileChange/requestApproval': {
        if (this.readOnly) return { decision: 'decline' };
        const files = this.changes.get(p.itemId) ?? [];
        for (const f of files) {
          const blocked = this.checkEdit('Edit', { file_path: f.path });
          if (blocked) return { decision: 'decline' };
        }
        const names = files.map((f) => path.basename(f.path)).join(', ');
        const diff = files.map((f) => f.diff ?? '').join('\n').trim();
        const ok = await this.permit('Edit', { file_path: files.length > 1 ? `${files.length} files: ${names}` : (files[0]?.path ?? ''), diff: diff || names }, 'edit');
        return { decision: ok.allow ? 'accept' : 'decline' };
      }
      case 'item/tool/call': {
        const args = (p.arguments && typeof p.arguments === 'object' ? p.arguments : {}) as Record<string, unknown>;
        const out = await this.runTool(String(p.tool), args);
        // Notices that came in while the tool ran ride along with its result, like for the other providers.
        const notice = this.takeNoticeText();
        const text = (out.error ? `Error: ${out.error}` : (out.result ?? '')) + (notice ? `\n\n${notice}` : '');
        return { contentItems: [{ type: 'inputText', text }], success: !out.error };
      }
      default:
        // Questions, extra permissions and MCP forms have no place on the canvas yet. Codex treats this as a no.
        throw new CodexRpcError(-32601, `Sinnect does not support ${method}`);
    }
  }

  private touch(file: string) {
    const abs = path.resolve(this.config.cwd, file);
    if (!this.state.filesTouched.includes(abs)) this.state.filesTouched.push(abs);
  }

  private count(u: any) {
    const t = u?.total;
    if (!t) return;
    const now = { input: t.inputTokens ?? 0, cached: t.cachedInputTokens ?? 0, output: t.outputTokens ?? 0 };
    if (!this.baseline) {
      // A resumed thread's totals include earlier sessions. Count only what this one spends.
      const last = u.last ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 };
      this.baseline = this.resumed ? { input: now.input - (last.inputTokens ?? 0), cached: now.cached - (last.cachedInputTokens ?? 0), output: now.output - (last.outputTokens ?? 0) } : { input: 0, cached: 0, output: 0 };
    }
    const cached = Math.max(0, now.cached - this.baseline.cached);
    const input = Math.max(0, now.input - this.baseline.input - cached);
    const output = Math.max(0, now.output - this.baseline.output);
    this.state.tokens = { input, output, cacheRead: cached, cacheWrite: 0 };
    // The plan pays for this, not per token. The estimate is what it would cost on the API, so budgets and helper caps still work.
    const price = openaiPrice(this.config.model);
    this.state.costUsd = (input * price.input + cached * price.cached + output * price.output) / 1_000_000;
    this.publish();
  }

  private replay(turns: any[]) {
    for (const t of turns) {
      for (const it of t?.items ?? []) {
        if (it.type === 'userMessage') {
          const text = (it.content ?? []).map((c: any) => c.text ?? '').join('');
          if (text && !text.startsWith('[Sinnect hub]')) this.feed('user', text);
        } else if (it.type === 'agentMessage' && it.text) this.feed('text', it.text);
        else if (it.type === 'commandExecution') this.feed('tool', describeTool('Bash', { command: it.command }), { toolName: 'Bash', input: { command: it.command } });
        else if (it.type === 'fileChange' && it.changes?.[0]) this.feed('tool', describeTool('Edit', { file_path: it.changes[0].path }), { toolName: 'Edit', input: { file_path: it.changes[0].path } });
        else if (it.type === 'dynamicToolCall') this.replayTool(it.tool, it.arguments ?? {});
      }
    }
  }

  private onExit(why: string) {
    if (this.closed) return;
    this.rpc = null;
    this.feed('error', `Codex stopped: ${why}`, { isError: true });
    if (this.busy) this.turnFinished(this.turnStarted);
    this.setStatus('error', 'Codex stopped');
  }

  private explain(e: any) {
    const msg = String(e?.message ?? e ?? '');
    const info = JSON.stringify(e?.codexErrorInfo ?? '');
    if (/usageLimit|usage limit|rate.?limit/i.test(msg + info)) return `Your ChatGPT plan's limit is reached for now. ${clip(msg, 160)}`;
    if (/unauthorized|sign.?in|login|401/i.test(msg + info)) return 'Codex is not signed in to ChatGPT. Sign in again in Settings.';
    return `Codex: ${clip(msg + (e?.additionalDetails ? ` ${e.additionalDetails}` : ''), 300)}`;
  }

  // ---------- LoopSession plumbing ----------

  protected dropPartialReply() {}

  protected friendlyError(err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return 'Stopped';
    if (err instanceof CodexRpcError) return this.explain(err);
    return err instanceof Error ? err.message : String(err);
  }

  /** Codex keeps the chat itself (resume uses the thread id), so only the id is saved. */
  protected historyData() {
    return { threadId: this.threadId };
  }

  protected restoreHistory() {}

  async interrupt() {
    this.stopTurn = true;
    if (this.rpc && this.threadId && this.turnId) await this.rpc.request('turn/interrupt', { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
  }

  protected async shutdown() {
    await this.interrupt();
    this.rpc?.close();
    this.rpc = null;
  }
}

const FILE_TOOL_NAMES = new Set(['read_file', 'list_files', 'search_text', 'write_file', 'edit_file', 'run_shell']);
