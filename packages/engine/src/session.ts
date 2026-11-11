// Shared session logic. RealSession (Agent SDK) and MockSession (demo mode)
// both extend this, so the Hub and the UI see the exact same behaviour.

import path from 'node:path';
import type { Hub } from './hub.js';
import { short } from './hub.js';
import type { SpawnOptions, WorkerSpec } from './workers.js';
import { READ_ONLY_KINDS } from './workers.js';
import type {
  ChatgptStatus,
  EngineSettings,
  FeedItem,
  HubMessage,
  PromptRequest,
  PromptResponse,
  SessionConfig,
  SessionState,
  SessionStatus,
} from './protocol.js';

export interface SessionHost {
  hub: Hub;
  settings(): EngineSettings;
  apiKey(): string | null;
  geminiKey(): string | null;
  openaiKey(): string | null;
  /** The Codex binary for ChatGPT-plan sessions, if installed. */
  codexBin?(): string | null;
  /** A ChatGPT-plan session saw new plan usage numbers. */
  planUsage?(usage: ChatgptStatus['usage']): void;
  /** Where the engine keeps its files. Gemini and OpenAI sessions save their chat history here. */
  dataDir: string;
  state(s: SessionState): void;
  feedAdd(id: string, item: FeedItem): void;
  feedDelta(id: string, itemId: string, text: string): void;
  ask(p: PromptRequest): Promise<PromptResponse>;
  nameOf(id: string): string;
  /** Called after each finished turn so the engine can check the budget. */
  turnDone(id: string): void;
  /** The [Sinnect memory] block for a new session. Empty when memory is off. */
  memoryContext(cfg: SessionConfig): string;
  /** Runs memory_save / skill_save / skill_get / memory_search for a session. */
  memoryTool(sessionId: string, name: MemoryToolName, args: Record<string, unknown>): string;
  /** Whether sessions get the memory tools at all. */
  memoryOn(): boolean;
  /** May this session spawn helpers right now (settings + its own config)? */
  canSpawn(id: string): boolean;
  /** Start helpers for a boss. Resolves with text for the boss: a "started" note, or every summary with wait=true. */
  spawnWorkers(bossId: string, specs: WorkerSpec[], opts?: SpawnOptions): Promise<string>;
}

export type MemoryToolName = 'memory_save' | 'skill_save' | 'skill_get' | 'memory_search';
export const MEMORY_TOOLS: MemoryToolName[] = ['memory_save', 'skill_save', 'skill_get', 'memory_search'];
export const isMemoryTool = (n: string): n is MemoryToolName => (MEMORY_TOOLS as string[]).includes(n);

/** Same wording for every provider so they all behave the same. */
export const MEMORY_TOOL_DOCS = {
  memory_save: 'Save one short lesson for future sessions: a repo rule, a command that works, or a trap and its fix. Only non-obvious facts that stay true. Never task summaries.',
  skill_save: 'Save a reusable multi-step procedure (a skill) any session can load later with skill_get. Same name again = update it.',
  skill_get: 'Load the full steps of a saved skill by name.',
  memory_search: 'Search saved lessons and skills by keywords. Returns short lines.',
} as const;

export const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

let itemSeq = 0;
export const newItemId = () => `i${Date.now().toString(36)}${(itemSeq++).toString(36)}`;

export abstract class BaseSession {
  readonly state: SessionState;
  protected queue: { text: string; depth: number }[] = [];
  /** Hub wake depth of the turn running now. 0 = the user started it. */
  turnDepth = 0;
  /** Wait this long before a hub wake starts a turn, so messages that arrive together share one turn. */
  protected wakeBatchMs = 1500;
  private wakeTimer: ReturnType<typeof setTimeout> | null = null;
  /** Hub notices waiting to be slipped into the next tool result. */
  protected notices: HubMessage[] = [];
  protected busy = false;
  /** A notice arrived that should start a turn once this one ends. */
  private pendingWake = false;
  protected closed = false;
  private stateTimer: ReturnType<typeof setTimeout> | null = null;
  private memoryCache: string | null = null;

  constructor(
    readonly id: string,
    config: SessionConfig,
    protected host: SessionHost,
  ) {
    this.state = {
      id,
      config,
      status: 'starting',
      activity: 'Starting up',
      goal: '',
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      sdkSessionId: config.resumeId ?? null,
      filesTouched: [],
      turns: 0,
      startedAt: Date.now(),
    };
  }

  abstract start(): void;
  abstract interrupt(): Promise<void>;
  protected abstract pushInput(text: string): void;
  protected abstract shutdown(): Promise<void>;

  get config() {
    return this.state.config;
  }

  /** Memory notes picked once at start, so the system prompt stays the same and caches well. */
  protected memoryBlock(): string {
    if (this.memoryCache === null) {
      try {
        this.memoryCache = this.host.memoryContext(this.config);
      } catch {
        this.memoryCache = '';
      }
    }
    return this.memoryCache;
  }

  /** A turn Sinnect starts itself (like "write down what you learned"). The feed shows `note`, not the prompt. */
  sendInternal(text: string, note: string) {
    if (this.closed) return;
    this.feed('system', note);
    this.queueTurn(text, 0);
  }

  get isBusy() {
    return this.busy;
  }

  /** Helpers that only look at things can't edit files. */
  protected get readOnly() {
    return !!this.config.parentId && !!this.config.workerKind && READ_ONLY_KINDS.has(this.config.workerKind);
  }

  /** Throttled state broadcast: at most ~20 per second per session. */
  protected publish(now = false) {
    if (now) {
      if (this.stateTimer) clearTimeout(this.stateTimer);
      this.stateTimer = null;
      this.host.state(this.state);
      return;
    }
    if (this.stateTimer) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      this.host.state(this.state);
    }, 50);
  }

  protected setStatus(status: SessionStatus, activity?: string) {
    // A stopped session stays stopped, even if some late callback tries to move it.
    if (this.closed && status !== 'stopped' && this.state.status === 'stopped') return;
    this.state.status = status;
    if (activity !== undefined) this.state.activity = activity;
    this.publish();
  }

  protected feed(kind: FeedItem['kind'], text: string, extra: Partial<FeedItem> = {}): FeedItem {
    const item: FeedItem = { id: newItemId(), ts: Date.now(), kind, text, ...extra };
    this.host.feedAdd(this.id, item);
    return item;
  }

  updateConfig(patch: Partial<SessionConfig>) {
    Object.assign(this.state.config, patch);
    this.publish(true);
  }

  /** Change the card's activity line from outside (the engine uses it for helpers). */
  setActivity(activity: string) {
    this.state.activity = activity;
    this.publish(true);
  }

  setGoal(goal: string) {
    this.state.goal = goal.slice(0, 160);
    this.publish();
  }

  /** User typed into the session. */
  send(text: string) {
    if (this.closed) return;
    this.feed('user', text);
    // Free status line for the roster, so the model doesn't need a tool call for it.
    if (!this.state.goal && this.config.awareness !== 'solo') this.setGoal(clip(text, 160));
    // Messages that arrived while idle (without a wake) ride along with the user's turn.
    const pending = this.busy ? null : this.takeNoticeText();
    this.queueTurn(pending ? `${pending}\n\n${text}` : text, 0);
  }

  protected queueTurn(text: string, depth: number) {
    if (this.busy) {
      this.queue.push({ text, depth });
      return;
    }
    this.startTurn(text, depth);
  }

  private startTurn(text: string, depth: number) {
    this.busy = true;
    this.turnDepth = depth;
    this.setStatus('thinking', 'Thinking');
    this.pushInput(text);
  }

  /** The engine calls this when a turn finishes. */
  protected onTurnEnd() {
    this.busy = false;
    this.state.turns += 1;
    // Claims only live for the turn that made them, so nothing gets locked forever.
    this.host.hub.release(this.id);
    this.host.turnDone(this.id);
    const next = this.queue.shift();
    if (next !== undefined) {
      this.startTurn(next.text, next.depth);
      return;
    }
    if (this.pendingWake) {
      this.scheduleWake();
      return;
    }
    if (this.state.status !== 'error' && this.state.status !== 'stopped') this.setStatus('idle', 'Waiting for you');
  }

  /** The Hub handed us a message. */
  deliver(msg: HubMessage, wake: boolean) {
    if (this.closed) return;
    const from = msg.from === 'hub' ? 'Hub' : this.host.nameOf(msg.from);
    const quiet = msg.kind === 'message' && !wake && !this.busy ? ' (no wake, it waits for the next turn)' : '';
    this.feed('hub', `${from}: ${msg.text}${quiet}`);
    this.notices.push(msg);
    if (wake) this.pendingWake = true;
    if (wake && !this.busy) this.scheduleWake();
  }

  /** Start a turn for pending notices after a short pause, so a burst of messages costs one turn. */
  private scheduleWake() {
    if (this.wakeTimer) return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null;
      if (this.closed || this.busy) return;
      this.flushNoticesAsTurn();
    }, this.wakeBatchMs);
    (this.wakeTimer as { unref?: () => void }).unref?.();
  }

  private flushNoticesAsTurn() {
    this.pendingWake = false;
    const depth = Math.max(1, ...this.notices.map((n) => n.depth ?? 1));
    const text = this.takeNoticeText();
    if (!text) return;
    this.queueTurn(text, depth);
  }

  /** Short text block with pending hub notices, then clears them. */
  takeNoticeText(): string | null {
    if (this.notices.length === 0) return null;
    const lines = this.notices.map((n) => {
      const from = n.from === 'hub' ? 'hub' : `${this.host.nameOf(n.from)} (${n.from})`;
      return `- from ${from}: ${n.text}`;
    });
    // Notices read in the middle of a turn carry their wake depth into it. Without
    // this a long user turn (depth 0) could answer woken replies at depth 1 again
    // and again, and the wake chain limit would never kick in.
    if (this.busy) this.turnDepth = Math.max(this.turnDepth, ...this.notices.map((n) => n.depth ?? 0));
    this.notices = [];
    // These were delivered, so the inbox doesn't need to show them again.
    this.host.hub.inbox(this.id);
    return `[Sinnect hub]\n${lines.join('\n')}`;
  }

  /** Shared PreToolUse logic: file claims. Returns a deny reason or null. */
  protected checkEdit(toolName: string, input: Record<string, unknown>): string | null {
    if (!EDIT_TOOLS.has(toolName)) return null;
    const raw = (input.file_path ?? input.notebook_path ?? input.path) as string | undefined;
    if (!raw) return null;
    const abs = normalizePath(path.resolve(this.config.cwd, raw));
    const reason = this.state.goal || `editing via ${toolName}`;
    const res = this.host.hub.requestEdit(this.id, abs, reason);
    if (!res.ok) {
      this.setStatus('blocked', `Waiting for ${short(abs)}`);
      this.feed('system', `Blocked from editing ${short(abs)}: ${res.reason}`);
      return res.reason;
    }
    if (!this.state.filesTouched.includes(abs)) {
      this.state.filesTouched.push(abs);
      if (this.state.filesTouched.length > 200) this.state.filesTouched.shift();
    }
    return null;
  }

  async stop() {
    if (this.closed) return;
    this.closed = true;
    if (this.wakeTimer) clearTimeout(this.wakeTimer);
    this.host.hub.forget(this.id);
    try {
      await this.shutdown();
    } catch {
      /* ignore */
    }
    this.setStatus('stopped', 'Stopped');
    this.publish(true);
  }
}

export function normalizePath(p: string) {
  const n = path.normalize(p);
  // Windows and macOS file systems ignore case by default, so Foo.ts and foo.ts are one file.
  return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
}

/** One cheap line describing a tool call, for the card. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const file = (k = 'file_path') => short(String(input[k] ?? input.path ?? ''));
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
      return `Editing ${file()}`;
    case 'Write':
      return `Writing ${file()}`;
    case 'NotebookEdit':
      return `Editing ${file('notebook_path')}`;
    case 'Read':
      return `Reading ${file()}`;
    case 'Bash':
      return `Running ${clip(String(input.description || input.command || ''), 48)}`;
    case 'Grep':
      return `Searching for "${clip(String(input.pattern ?? ''), 32)}"`;
    case 'Glob':
      return `Finding ${clip(String(input.pattern ?? ''), 40)}`;
    case 'WebFetch':
      return `Reading ${clip(String(input.url ?? ''), 44)}`;
    case 'WebSearch':
      return `Searching the web: ${clip(String(input.query ?? ''), 36)}`;
    case 'Task':
    case 'Agent':
      return `Running a helper: ${clip(String(input.description ?? ''), 36)}`;
    case 'TodoWrite':
      return 'Planning next steps';
    case 'AskUserQuestion':
      return 'Asking you something';
    case 'mcp__sinnect__spawn_workers': {
      const n = Array.isArray(input.workers) ? input.workers.length : 1;
      return `Handing work to ${n} helper${n === 1 ? '' : 's'}`;
    }
    case 'mcp__sinnect__memory_save':
      return `Remembering: ${clip(String(input.title ?? ''), 40)}`;
    case 'mcp__sinnect__skill_save':
      return `Saving skill: ${clip(String(input.name ?? ''), 40)}`;
    case 'mcp__sinnect__skill_get':
      return `Using skill: ${clip(String(input.name ?? ''), 40)}`;
    case 'mcp__sinnect__memory_search':
      return `Checking memory for "${clip(String(input.query ?? ''), 30)}"`;
    default:
      if (name.startsWith('mcp__sinnect__')) return 'Syncing with other sessions';
      return `Using ${name.replace(/^mcp__/, '').replace(/__/g, ' ')}`;
  }
}

export function clip(s: string, n: number) {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? one.slice(0, n - 1) + '…' : one;
}

/** System prompt addition that teaches a session about Sinnect. Kept short on purpose. */
export function sinnectPrompt(cfg: SessionConfig, roster: string, ownLoop = false, memory = '', helpers = false): string {
  const base = sinnectBase(cfg, roster, ownLoop);
  return [base, helpers ? helpersPrompt(ownLoop) : '', memory].filter(Boolean).join('\n\n');
}

/**
 * Without this the boss only sees spawn_workers in its tool list, and Claude sessions just used
 * Claude Code's own subagents instead (same pricey model, invisible on the canvas).
 */
export function helpersPrompt(ownLoop: boolean): string {
  return [
    `Helpers: spawn_workers hands self-contained jobs to helper sessions. They run in parallel on cheaper models picked for the job and show up on the user's canvas.${ownLoop ? '' : ' Use spawn_workers instead of the built-in Task/Agent subagent tool.'}`,
    `- Good jobs for helpers: a broad search, reading many files, running the tests, independent changes in separate files. Not worth it for something you can do in one or two tool calls.`,
    `- Each task must stand on its own (paths, what to look for, what to report). Helpers can't see this conversation.`,
    `- They run in the background. You get one ${'[Sinnect helpers]'} message with every summary when all are done. Meanwhile keep working on other parts, or end your turn. Only set wait=true if you can't do anything until they report.`,
  ].join('\n');
}

function sinnectBase(cfg: SessionConfig, roster: string, ownLoop: boolean): string {
  const what = ownLoop ? 'AI sessions (Claude, Gemini and GPT)' : 'Claude sessions';
  if (cfg.awareness === 'solo') {
    return `You are running inside Sinnect, a canvas of ${what}. File edits are coordinated for you: if an edit is blocked because another session holds the file, work on something else and wait for a [Sinnect hub] notice.`;
  }
  return [
    `You are "${cfg.name}", one of several ${what} on a Sinnect canvas. Your priority is ${cfg.priority} (1 low, 5 high).`,
    `Coordination tools${ownLoop ? '' : ' (mcp__sinnect__*)'}: hub_send (short message to another session), hub_roster, hub_set_status, hub_inbox, hub_claim / hub_release (optional, edits are claimed automatically), hub_negotiate (answer a file negotiation).`,
    `Token rules, every hub message can cost the other session a full turn:`,
    `- Only message someone when it changes what they should do. Never send thanks, acks, "got it", "noted", or progress updates.`,
    `- A hub message does not need a reply unless it asks you a question. If you reply, put everything in one message.`,
    `- hub_send wake=true starts a turn for them right now. Use it only for a task or a blocking question. Otherwise leave it off, they see it on their next step.`,
    `- Your status is set from your task automatically. Only call hub_set_status if your goal really changes.`,
    `- Don't poll hub_inbox or hub_roster, notices arrive by themselves as [Sinnect hub] blocks. If an edit is blocked, do other work and wait for a notice.`,
    `Sessions you could see when you started:\n${roster}`,
  ].join('\n');
}
