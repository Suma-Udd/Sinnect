// The shared half of every session that runs its own agent loop (Gemini and
// OpenAI). Claude sessions get their tools from the Agent SDK; these providers
// have no such SDK, so Sinnect runs the loop itself: stream a reply, run the
// tools the model asks for (files, search, shell, hub, memory, helpers), send
// the results back, and repeat until the model is done.
//
// Everything that doesn't depend on the provider lives here: the tool list,
// running the tools, permission prompts, the shell, saving the chat. Each
// provider file only knows how to talk to its own API.
//
// It extends BaseSession like the Claude and demo sessions, so the Hub, wires,
// file claims, permission prompts and the canvas all work the same way.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { SPAWN_TOOL_DOC } from './workers.js';
import { WORKER_KINDS } from './protocol.js';
import { BaseSession, clip, describeTool, isMemoryTool, MEMORY_TOOL_DOCS, newItemId, normalizePath, sinnectPrompt } from './session.js';

/** Tool rounds per turn before the session stops and asks the user to continue. */
export const MAX_STEPS = 60;
/** Tool output is clipped to this before it goes back to the model. Keeps every turn cheap. */
export const MAX_TOOL_CHARS = 24_000;
/** When the chat history grows past this many characters, old tool outputs get trimmed. */
export const HISTORY_SOFT_LIMIT = 600_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', '.venv', '__pycache__']);

/** Swappable for tests. Every provider goes through this. */
export const net = { fetch: (...a: Parameters<typeof fetch>) => fetch(...a) };

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- tool declarations (what the model sees), as plain JSON Schema ----------

export type Schema = { type: string; description?: string; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: readonly string[] };
export type ToolSpec = { name: string; description: string; parameters: Schema };

const S = (description: string): Schema => ({ type: 'string', description });
const decl = (name: string, description: string, props: Record<string, Schema> = {}, required: string[] = []): ToolSpec => ({
  name,
  description,
  parameters: { type: 'object', properties: props, required },
});

const FILE_TOOLS = [
  decl('read_file', 'Read a text file. Returns numbered lines. Use offset/limit for big files.', {
    path: S('File path, relative to the working folder or absolute'),
    offset: { type: 'integer', description: 'First line to read, 1-based' },
    limit: { type: 'integer', description: 'How many lines (default 800)' },
  }, ['path']),
  decl('list_files', 'List files under a folder, optionally filtered by a glob like "src/**/*.ts". Skips node_modules and .git.', {
    path: S('Folder, default is the working folder'),
    pattern: S('Glob filter, optional'),
  }),
  decl('search_text', 'Search file contents with a regular expression. Returns file:line: text matches.', {
    pattern: S('Regular expression'),
    path: S('Folder or file to search, default is the working folder'),
    glob: S('Only search files matching this glob, optional'),
  }, ['pattern']),
  decl('write_file', 'Create or overwrite a file with the full content.', { path: S('File path'), content: S('Full file content') }, ['path', 'content']),
  decl('edit_file', 'Replace exact text in a file. old_text must match exactly once unless replace_all is true. Read the file first.', {
    path: S('File path'),
    old_text: S('Exact text to replace'),
    new_text: S('Replacement text'),
    replace_all: { type: 'boolean', description: 'Replace every match' },
  }, ['path', 'old_text', 'new_text']),
  decl('run_shell', `Run a shell command in the working folder (${shellName()}). 2 minute timeout.`, {
    command: S('The command'),
    description: S('Five words on what it does, shown to the user'),
  }, ['command']),
];

const HUB_TOOLS = [
  decl('hub_roster', 'List the other Sinnect sessions you can see, one line each.'),
  decl('hub_set_status', 'Set your one-line goal so other sessions know what you are doing. Max 160 characters.', { goal: S('Your goal') }, ['goal']),
  decl('hub_send', 'Send a short message to another session (by id from hub_roster). Only when it changes what they should do. Never for thanks, acks or progress updates.', {
    to: S('Session id'),
    message: S('The message'),
    wake: { type: 'boolean', description: 'true = start a turn for them now (costs them a full turn). Only for a task or a blocking question.' },
  }, ['to', 'message']),
  decl('hub_inbox', 'Read unread hub messages. You rarely need this, notices arrive by themselves.'),
  decl('hub_claim', 'Claim files before a bigger change so others know. Edits claim files automatically, so this is optional.', {
    paths: { type: 'array', items: { type: 'string' } },
    reason: S('Why'),
  }, ['paths', 'reason']),
  decl('hub_release', 'Release your file claims (all if no paths). Claims are also released when your turn ends.', {
    paths: { type: 'array', items: { type: 'string' } },
  }),
  decl('hub_negotiate', 'Answer a file negotiation from a [Sinnect hub] notice.', {
    id: S('Negotiation id'),
    choice: { type: 'string', enum: ['yield', 'insist'] },
    note: S('Short reason'),
  }, ['id', 'choice', 'note']),
];

const MEMORY_DECLS = [
  decl('memory_save', MEMORY_TOOL_DOCS.memory_save, {
    type: { type: 'string', enum: ['rule', 'worked', 'broke'] },
    title: S('Max 8 words'),
    note: S('One or two sentences'),
    everywhere: { type: 'boolean', description: 'true if it applies to every project' },
  }, ['type', 'title', 'note']),
  decl('skill_save', MEMORY_TOOL_DOCS.skill_save, { name: S('Skill name'), description: S('When to use it, one line'), steps: S('Numbered steps') }, ['name', 'description', 'steps']),
  decl('skill_get', MEMORY_TOOL_DOCS.skill_get, { name: S('Skill name') }, ['name']),
  decl('memory_search', MEMORY_TOOL_DOCS.memory_search, { query: S('Keywords') }, ['query']),
];

const SPAWN_DECL = decl('spawn_workers', SPAWN_TOOL_DOC, {
  workers: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        task: S('Everything the helper needs to know. It cannot see your conversation.'),
        kind: { type: 'string', enum: WORKER_KINDS, description: 'Picks the model. Guessed from the task if left out.' },
      },
      required: ['task'],
    },
  },
}, ['workers']);

/** Our tool names mapped onto Claude Code's, so the card and the feed show them the same way. */
export function asClaudeTool(name: string, a: Record<string, unknown>): { toolName: string; input: Record<string, unknown> } {
  switch (name) {
    case 'read_file':
      return { toolName: 'Read', input: { file_path: a.path } };
    case 'write_file':
      return { toolName: 'Write', input: { file_path: a.path, content: a.content } };
    case 'edit_file':
      return { toolName: 'Edit', input: { file_path: a.path, old_string: a.old_text, new_string: a.new_text } };
    case 'run_shell':
      return { toolName: 'Bash', input: { command: a.command, description: a.description } };
    case 'search_text':
      return { toolName: 'Grep', input: { pattern: a.pattern, path: a.path } };
    case 'list_files':
      return { toolName: 'Glob', input: { pattern: a.pattern || a.path || '.' } };
    default:
      return { toolName: name.startsWith('hub_') || isMemoryTool(name) || name === 'spawn_workers' ? `mcp__sinnect__${name}` : name, input: a };
  }
}

export type SessionTokens = BaseSession['state']['tokens'];
export type ToolOut = { result?: string; error?: string };

export abstract class LoopSession extends BaseSession {
  protected abort: AbortController | null = null;
  protected child: ChildProcess | null = null;
  protected stopTurn = false;
  /** Set when the user picks "always allow" on a prompt. */
  private allowEdits = false;
  private allowShell = false;
  private sysPrompt: string | null = null;

  /** Short provider name: the history folder and the resume id prefix ("gemini", "openai"). */
  protected abstract readonly provider: string;
  /** Run one user turn: call the model, run tools, repeat. */
  protected abstract runTurn(text: string): Promise<void>;
  /** After an error: drop a half-finished reply so the next request is valid. */
  protected abstract dropPartialReply(): void;
  /** Turn an API error into one line the user understands. */
  protected abstract friendlyError(err: unknown): string;
  /** The chat as saved to disk. */
  protected abstract historyData(): unknown;
  /** Load a saved chat and replay it into the feed. Throws if it can't. */
  protected abstract restoreHistory(data: unknown): void;

  start() {
    const resume = this.config.resumeId;
    this.state.sdkSessionId = resume && resume.startsWith(`${this.provider}-`) ? resume : `${this.provider}-${this.id}-${Date.now().toString(36)}`;
    if (resume) this.loadHistory();
    if (this.config.prompt.trim()) this.send(this.config.prompt);
    else this.setStatus('idle', 'Waiting for you');
  }

  protected pushInput(text: string) {
    this.stopTurn = false;
    this.runTurn(text).catch((e) => this.turnFailed(e));
  }

  /** Call when the loop finishes normally. */
  protected turnFinished(started: number) {
    if (this.closed) return;
    this.feed('result', this.stopTurn ? 'Stopped' : `Done in ${Math.round((Date.now() - started) / 1000)}s`);
    this.save();
    this.onTurnEnd();
  }

  private turnFailed(err: unknown) {
    if (this.closed) return;
    this.child?.kill();
    this.dropPartialReply();
    this.save();
    if (this.stopTurn || (err instanceof Error && err.name === 'AbortError')) {
      this.feed('result', 'Stopped');
      this.onTurnEnd();
      return;
    }
    const msg = this.friendlyError(err);
    this.feed('error', msg, { isError: true });
    this.onTurnEnd();
    // The session stays usable: the next message just tries again.
    this.setStatus('idle', clip(msg, 80));
  }

  /**
   * Built once, like the Claude sessions do. Providers cache the start of each
   * request, so a system prompt that changes (the live roster flips every time
   * another session starts a tool) would throw away the cache for the whole
   * chat on every step. The roster is described as "when you started", and
   * hub_roster gives the live one.
   */
  protected systemPrompt() {
    if (this.sysPrompt !== null) return this.sysPrompt;
    const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
    const text = [
      `You are a coding agent working in the folder ${this.config.cwd} on ${os}. Today is ${new Date().toISOString().slice(0, 10)}.`,
      `Use the tools to read, search and change files and to run commands. Look before you edit: read a file before edit_file. Keep replies short and say what you changed.`,
      `Paths can be relative to the working folder. Shell commands run in ${shellName()}.`,
      sinnectPrompt(this.config, this.host.hub.roster(this.id), true, this.memoryBlock()),
    ].join('\n');
    this.sysPrompt = text;
    return text;
  }

  /** The tools this session may use right now. */
  protected toolSpecs(): ToolSpec[] {
    const files = this.readOnly ? FILE_TOOLS.filter((d) => d.name !== 'write_file' && d.name !== 'edit_file') : FILE_TOOLS;
    return [
      ...files,
      ...(this.config.awareness === 'solo' ? [] : HUB_TOOLS),
      ...(this.host.memoryOn() ? MEMORY_DECLS : []),
      ...(this.host.canSpawn(this.id) ? [SPAWN_DECL] : []),
    ];
  }

  // ---------- tools ----------

  protected async runTool(name: string, args: Record<string, unknown>): Promise<ToolOut> {
    const { toolName, input } = asClaudeTool(name, args);
    const line = describeTool(toolName, input);
    const toolUseId = newItemId();
    this.feed('tool', line, { toolName, toolUseId, input });
    if (this.state.status !== 'blocked') this.setStatus('working', line);
    let out: ToolOut;
    try {
      out = await this.tool(name, args, toolName, input);
    } catch (e) {
      out = { error: e instanceof Error ? e.message : String(e) };
    }
    if (out.result !== undefined) out.result = clipTool(out.result);
    this.feed('tool_result', clip(out.error ?? out.result ?? '', 4000), { toolUseId, isError: !!out.error });
    return out;
  }

  private abs(p: unknown) {
    return path.resolve(this.config.cwd, String(p ?? '.'));
  }

  private async tool(name: string, a: Record<string, unknown>, toolName: string, input: Record<string, unknown>): Promise<ToolOut> {
    const hub = this.host.hub;
    switch (name) {
      case 'read_file': {
        const lines = fs.readFileSync(this.abs(a.path), 'utf8').split(/\r?\n/);
        const from = Math.max(1, Number(a.offset) || 1);
        const to = Math.min(lines.length, from - 1 + (Number(a.limit) || 800));
        const body = lines.slice(from - 1, to).map((l, i) => `${String(from + i).padStart(5)}  ${l}`).join('\n');
        return { result: to < lines.length ? `${body}\n… ${lines.length - to} more lines, use offset ${to + 1}` : body || '(empty file)' };
      }
      case 'list_files': {
        const root = this.abs(a.path);
        const re = a.pattern ? globToRe(String(a.pattern)) : null;
        const found: string[] = [];
        walk(root, (f) => {
          const rel = path.relative(root, f).split(path.sep).join('/');
          if (!re || re.test(rel)) found.push(rel);
          return found.length < 400;
        });
        return { result: found.length ? found.join('\n') + (found.length >= 400 ? '\n… more files not shown' : '') : 'No files found.' };
      }
      case 'search_text': {
        let re: RegExp;
        try {
          re = new RegExp(String(a.pattern));
        } catch (e) {
          return { error: `Bad regular expression: ${e instanceof Error ? e.message : e}` };
        }
        const root = this.abs(a.path);
        const only = a.glob ? globToRe(String(a.glob)) : null;
        const hits: string[] = [];
        const scan = (f: string) => {
          const rel = path.relative(this.config.cwd, f).split(path.sep).join('/');
          if (only && !only.test(path.basename(f)) && !only.test(rel)) return true;
          let text: string;
          try {
            if (fs.statSync(f).size > 1_000_000) return true;
            text = fs.readFileSync(f, 'utf8');
          } catch {
            return true;
          }
          if (text.includes('\u0000')) return true;
          text.split(/\r?\n/).forEach((l, i) => {
            if (hits.length < 150 && re.test(l)) hits.push(`${rel}:${i + 1}: ${clip(l, 200)}`);
          });
          return hits.length < 150;
        };
        if (fs.existsSync(root) && fs.statSync(root).isFile()) scan(root);
        else walk(root, scan);
        return { result: hits.length ? hits.join('\n') : 'No matches.' };
      }
      case 'write_file':
      case 'edit_file': {
        if (this.readOnly) return { error: 'This helper only looks at files, it cannot change them.' };
        const blocked = this.checkEdit(toolName, input);
        if (blocked) return { error: blocked };
        const ok = await this.permit(toolName, input, 'edit');
        if (!ok.allow) return { error: ok.message };
        const file = this.abs(a.path);
        if (name === 'write_file') {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, String(a.content ?? ''));
          return { result: `Wrote ${String(a.content ?? '').split('\n').length} lines to ${a.path}.` };
        }
        const before = fs.readFileSync(file, 'utf8');
        let oldText = String(a.old_text ?? '');
        let newText = String(a.new_text ?? '');
        // Windows files: the model writes \n, the file has \r\n.
        if (!before.includes(oldText) && before.includes('\r\n')) {
          oldText = oldText.replace(/\r?\n/g, '\r\n');
          newText = newText.replace(/\r?\n/g, '\r\n');
        }
        const n = oldText ? before.split(oldText).length - 1 : 0;
        if (n === 0) return { error: 'old_text was not found in the file. Read the file again and copy the text exactly.' };
        if (n > 1 && !a.replace_all) return { error: `old_text matches ${n} places. Add more surrounding lines, or set replace_all.` };
        fs.writeFileSync(file, a.replace_all ? before.split(oldText).join(newText) : before.replace(oldText, () => newText));
        return { result: `Edited ${a.path} (${a.replace_all ? n : 1} change${n > 1 && a.replace_all ? 's' : ''}).` };
      }
      case 'run_shell': {
        const ok = await this.permit(toolName, input, 'shell');
        if (!ok.allow) return { error: ok.message };
        this.setStatus('working', describeTool(toolName, input));
        return this.shell(String(a.command ?? ''));
      }
      case 'hub_roster':
        return { result: hub.roster(this.id) };
      case 'hub_set_status':
        this.setGoal(String(a.goal ?? ''));
        return { result: 'Status updated.' };
      case 'hub_send': {
        const r = hub.send(this.id, String(a.to ?? ''), String(a.message ?? ''), { wake: !!a.wake, depth: this.turnDepth });
        if (!r.ok) return { error: r.error };
        if (r.woke) return { result: 'Sent, they are starting on it.' };
        if (r.held) return { result: `Sent. Not waking them (${r.held}), they'll see it on their next turn.` };
        return { result: "Sent. They'll see it on their next step." };
      }
      case 'hub_inbox': {
        const box = hub.inbox(this.id);
        return { result: box.length ? box.map((m) => `- ${m.from === 'hub' ? 'hub' : this.host.nameOf(m.from)}: ${m.text}`).join('\n') : 'No unread messages.' };
      }
      case 'hub_claim': {
        const paths = (Array.isArray(a.paths) ? a.paths : []).slice(0, 20).map((p) => normalizePath(this.abs(p)));
        const res = hub.claim(this.id, paths, String(a.reason ?? '').slice(0, 160));
        return { result: res.map((r) => `${r.path}: ${r.result.ok ? 'claimed' : r.result.reason}`).join('\n') || 'Nothing to claim.' };
      }
      case 'hub_release': {
        const paths = Array.isArray(a.paths) ? a.paths.map((p) => normalizePath(this.abs(p))) : undefined;
        const done = hub.release(this.id, paths);
        return { result: done.length ? `Released ${done.length} file(s).` : 'Nothing to release.' };
      }
      case 'hub_negotiate': {
        const choice = a.choice === 'insist' ? 'insist' : 'yield';
        return { result: hub.negotiate(this.id, String(a.id ?? ''), choice, String(a.note ?? '').slice(0, 200)) };
      }
      case 'spawn_workers': {
        if (!this.host.canSpawn(this.id)) return { error: 'Spawning helpers is turned off for this session.' };
        const list = Array.isArray(a.workers) ? a.workers : [];
        return { result: await this.host.spawnWorkers(this.id, list as never) };
      }
      default:
        if (isMemoryTool(name)) return { result: this.host.memoryTool(this.id, name, a) };
        return { error: `Unknown tool ${name}.` };
    }
  }

  /** Same rules as Claude sessions: "Ask me" asks for edits and commands, "Auto edits" only for commands, "Full auto" never. */
  private async permit(toolName: string, input: Record<string, unknown>, kind: 'edit' | 'shell'): Promise<{ allow: boolean; message: string }> {
    const p = this.config.permission;
    if (p === 'auto') return { allow: true, message: '' };
    if (kind === 'edit' && (p === 'acceptEdits' || this.allowEdits)) return { allow: true, message: '' };
    if (kind === 'shell' && this.allowShell) return { allow: true, message: '' };
    const prev = this.state.status;
    this.setStatus('waiting', `Needs your OK: ${toolName}`);
    const res = await this.host.ask({
      kind: 'tool',
      requestId: newItemId(),
      sessionId: this.id,
      toolName,
      title: kind === 'shell' ? `${this.config.name} wants to run a command` : `${this.config.name} wants to ${toolName === 'Write' ? 'write' : 'edit'} ${path.basename(String(input.file_path ?? ''))}`,
      detail: toolDetail(toolName, input),
      canAlwaysAllow: true,
    });
    this.setStatus(prev === 'waiting' ? 'working' : prev, describeTool(toolName, input));
    if (res.kind !== 'tool' || res.decision === 'deny') return { allow: false, message: res.kind === 'tool' && res.message ? `The user said no: ${res.message}` : 'The user said no.' };
    if (res.decision === 'always') {
      if (kind === 'edit') this.allowEdits = true;
      else this.allowShell = true;
    }
    return { allow: true, message: '' };
  }

  private shell(command: string): Promise<ToolOut> {
    return new Promise((resolve) => {
      const [exe, args] = process.platform === 'win32' ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command]] : [process.env.SHELL || '/bin/bash', ['-c', command]];
      let out = '';
      const child = spawn(exe, args, { cwd: this.config.cwd, env: process.env, windowsHide: true });
      this.child = child;
      const add = (d: Buffer) => {
        if (out.length < MAX_TOOL_CHARS * 2) out += d.toString();
      };
      child.stdout?.on('data', add);
      child.stderr?.on('data', add);
      const timer = setTimeout(() => child.kill(), 120_000);
      child.on('error', (e) => {
        clearTimeout(timer);
        this.child = null;
        resolve({ error: e.message });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        this.child = null;
        const tail = signal ? `\n(stopped: ${signal})` : code ? `\n(exit code ${code})` : '';
        resolve({ result: (out.trim() || '(no output)') + tail });
      });
    });
  }

  // ---------- history ----------

  private historyFile() {
    return path.join(this.host.dataDir, this.provider, `${(this.state.sdkSessionId ?? this.id).replace(/[^\w-]/g, '_')}.json`);
  }

  protected save() {
    if (!this.host.dataDir) return;
    try {
      const file = this.historyFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(this.historyData()));
    } catch {
      /* history is a nice-to-have */
    }
  }

  private loadHistory() {
    try {
      this.restoreHistory(JSON.parse(fs.readFileSync(this.historyFile(), 'utf8')));
      this.feed('system', 'Resumed from your workspace');
    } catch {
      this.feed('system', 'Could not find the earlier chat, starting fresh');
    }
  }

  /** Replays a saved tool call into the feed. */
  protected replayTool(name: string, args: Record<string, unknown>) {
    const t = asClaudeTool(name, args);
    this.feed('tool', describeTool(t.toolName, t.input), { toolName: t.toolName, input: t.input });
  }

  async interrupt() {
    this.stopTurn = true;
    this.abort?.abort();
    this.child?.kill();
  }

  protected async shutdown() {
    await this.interrupt();
  }
}

// ---------- helpers ----------

/** Reads a server-sent event stream. Yields { event, data } with data parsed as JSON. */
export async function* sse(res: Response): AsyncGenerator<{ event: string; data: any }> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buf = '';
  const parse = (block: string) => {
    let event = '';
    const data: string[] = [];
    for (const l of block.split(/\r?\n/)) {
      if (l.startsWith('event:')) event = l.slice(6).trim();
      else if (l.startsWith('data:')) data.push(l.slice(5).trim());
    }
    const joined = data.join('');
    if (!joined || joined === '[DONE]') return null;
    return { event, data: JSON.parse(joined) };
  };
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0 || (i = buf.indexOf('\r\n\r\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + (buf.startsWith('\r\n\r\n', i) ? 4 : 2));
      const ev = parse(block);
      if (ev) yield ev;
    }
  }
  const rest = buf.trim();
  if (rest) {
    const ev = parse(rest.startsWith('data:') || rest.startsWith('event:') ? rest : `data: ${rest}`);
    if (ev) yield ev;
  }
}

/** The "message" out of a JSON error body, or the body itself. */
export function apiMessage(body: string) {
  try {
    const e = (JSON.parse(body) as { error?: { message?: string } | string }).error;
    return (typeof e === 'string' ? e : e?.message) ?? '';
  } catch {
    return clip(body, 300);
  }
}

function clipTool(s: string) {
  return s.length > MAX_TOOL_CHARS ? `${s.slice(0, MAX_TOOL_CHARS)}\n… ${s.length - MAX_TOOL_CHARS} more characters cut` : s;
}

function shellName() {
  return process.platform === 'win32' ? 'PowerShell' : 'bash';
}

function toolDetail(name: string, input: Record<string, unknown>): string {
  if (name === 'Bash') return String(input.command ?? '');
  if (name === 'Write') return `${input.file_path}\n\n${clip(String(input.content ?? ''), 600)}`;
  if (name === 'Edit') return `${input.file_path}\n\n- ${clip(String(input.old_string ?? ''), 280)}\n+ ${clip(String(input.new_string ?? ''), 280)}`;
  return clip(JSON.stringify(input), 600);
}

/** Walk files depth first. The visitor returns false to stop. */
function walk(dir: string, visit: (file: string) => boolean): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return true;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (!walk(full, visit)) return false;
    } else if (e.isFile() && !visit(full)) return false;
  }
  return true;
}

/** Tiny glob: ** any folders, * anything but a slash, ? one character. A pattern without a slash matches the file name anywhere. */
export function globToRe(glob: string): RegExp {
  let g = glob.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!g.includes('/')) g = `**/${g}`;
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i++;
      if (g[i + 1] === '/') {
        i++;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else if (c === '{') {
      const end = g.indexOf('}', i);
      if (end > i) {
        re += `(?:${g.slice(i + 1, end).split(',').map(escape).join('|')})`;
        i = end;
      } else re += '\\{';
    } else re += escape(c);
  }
  return new RegExp(`^${re}$`, process.platform === 'linux' ? '' : 'i');
}

function escape(s: string) {
  return s.replace(/[.+^${}()|[\]\\]/g, '\\$&');
}
