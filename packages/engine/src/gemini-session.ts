// A session backed by Google's Gemini API (works with the free key from
// aistudio.google.com). Claude sessions get their tools from the Agent SDK;
// Gemini has no such SDK, so this file runs the agent loop itself: it streams a
// reply, runs the tools the model asks for (files, search, shell, hub), sends
// the results back, and repeats until the model is done.
//
// It extends BaseSession like the Claude and demo sessions, so the Hub, wires,
// file claims, permission prompts and the canvas all work the same way.

import fs from 'node:fs';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { SPAWN_TOOL_DOC } from './workers.js';
import { WORKER_KINDS } from './protocol.js';
import { BaseSession, clip, describeTool, isMemoryTool, MEMORY_TOOL_DOCS, newItemId, normalizePath, sinnectPrompt } from './session.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';
/** Tool rounds per turn before the session stops and asks the user to continue. */
const MAX_STEPS = 60;
/** Tool output is clipped to this before it goes back to the model. Keeps every turn cheap. */
const MAX_TOOL_CHARS = 24_000;
/** When the chat history grows past this many characters, old tool outputs get trimmed. */
const HISTORY_SOFT_LIMIT = 600_000;
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'target', '.next', '.venv', '__pycache__']);

/** Swappable for tests. */
export const net = { fetch: (...a: Parameters<typeof fetch>) => fetch(...a) };

type Part = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
};
type Content = { role: 'user' | 'model'; parts: Part[] };
type Usage = { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number };

class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

// ---------- tool declarations (what the model sees) ----------

const S = (description: string) => ({ type: 'STRING', description });
const decl = (name: string, description: string, props: Record<string, unknown> = {}, required: string[] = []) => ({
  name,
  description,
  parameters: { type: 'OBJECT', properties: props, required },
});

const FILE_TOOLS = [
  decl('read_file', 'Read a text file. Returns numbered lines. Use offset/limit for big files.', {
    path: S('File path, relative to the working folder or absolute'),
    offset: { type: 'INTEGER', description: 'First line to read, 1-based' },
    limit: { type: 'INTEGER', description: 'How many lines (default 800)' },
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
    replace_all: { type: 'BOOLEAN', description: 'Replace every match' },
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
    wake: { type: 'BOOLEAN', description: 'true = start a turn for them now (costs them a full turn). Only for a task or a blocking question.' },
  }, ['to', 'message']),
  decl('hub_inbox', 'Read unread hub messages. You rarely need this, notices arrive by themselves.'),
  decl('hub_claim', 'Claim files before a bigger change so others know. Edits claim files automatically, so this is optional.', {
    paths: { type: 'ARRAY', items: { type: 'STRING' } },
    reason: S('Why'),
  }, ['paths', 'reason']),
  decl('hub_release', 'Release your file claims (all if no paths). Claims are also released when your turn ends.', {
    paths: { type: 'ARRAY', items: { type: 'STRING' } },
  }),
  decl('hub_negotiate', 'Answer a file negotiation from a [Sinnect hub] notice.', {
    id: S('Negotiation id'),
    choice: { type: 'STRING', enum: ['yield', 'insist'] },
    note: S('Short reason'),
  }, ['id', 'choice', 'note']),
];

const MEMORY_DECLS = [
  decl('memory_save', MEMORY_TOOL_DOCS.memory_save, {
    type: { type: 'STRING', enum: ['rule', 'worked', 'broke'] },
    title: S('Max 8 words'),
    note: S('One or two sentences'),
    everywhere: { type: 'BOOLEAN', description: 'true if it applies to every project' },
  }, ['type', 'title', 'note']),
  decl('skill_save', MEMORY_TOOL_DOCS.skill_save, { name: S('Skill name'), description: S('When to use it, one line'), steps: S('Numbered steps') }, ['name', 'description', 'steps']),
  decl('skill_get', MEMORY_TOOL_DOCS.skill_get, { name: S('Skill name') }, ['name']),
  decl('memory_search', MEMORY_TOOL_DOCS.memory_search, { query: S('Keywords') }, ['query']),
];

const SPAWN_DECL = decl('spawn_workers', SPAWN_TOOL_DOC, {
  workers: {
    type: 'ARRAY',
    items: {
      type: 'OBJECT',
      properties: {
        task: S('Everything the helper needs to know. It cannot see your conversation.'),
        kind: { type: 'STRING', enum: WORKER_KINDS, description: 'Picks the model. Guessed from the task if left out.' },
      },
      required: ['task'],
    },
  },
}, ['workers']);

/** Our tool names mapped onto Claude Code's, so the card and the feed show them the same way. */
function asClaudeTool(name: string, a: Record<string, unknown>): { toolName: string; input: Record<string, unknown> } {
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

export class GeminiSession extends BaseSession {
  private contents: Content[] = [];
  private abort: AbortController | null = null;
  private child: ChildProcess | null = null;
  private stopTurn = false;
  /** Set when the user picks "always allow" on a prompt. */
  private allowEdits = false;
  private allowShell = false;
  private noThinking = false;
  /** Cost before the request that's streaming now (see count). */
  private costBase: { tokens: SessionTokens; usd: number } | null = null;

  private get model() {
    return this.config.model.replace(/^models\//, '');
  }

  start() {
    const resume = this.config.resumeId;
    this.state.sdkSessionId = resume && resume.startsWith('gemini-') ? resume : `gemini-${this.id}-${Date.now().toString(36)}`;
    if (resume) this.loadHistory();
    if (this.config.prompt.trim()) this.send(this.config.prompt);
    else this.setStatus('idle', 'Waiting for you');
  }

  protected pushInput(text: string) {
    this.stopTurn = false;
    this.runTurn(text).catch((e) => this.turnFailed(e));
  }

  // ---------- the agent loop ----------

  private async runTurn(text: string) {
    const started = Date.now();
    this.addUser([{ text }]);
    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.closed || this.stopTurn) break;
      this.trimHistory();
      const parts = await this.generate();
      if (parts.length) this.contents.push({ role: 'model', parts });
      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length) break;

      const replies: Part[] = [];
      for (const c of calls) {
        const fc = c.functionCall!;
        if (this.closed || this.stopTurn) {
          replies.push({ functionResponse: { name: fc.name, id: fc.id, response: { error: 'Stopped by the user.' } } });
          continue;
        }
        const out = await this.runTool(fc.name, fc.args ?? {});
        replies.push({ functionResponse: { name: fc.name, id: fc.id, response: out.error ? { error: out.error } : { result: out.result } } });
      }
      // Hub notices ride along with the tool results, like the Claude hook does.
      const notice = this.takeNoticeText();
      if (notice) replies.push({ text: notice });
      this.addUser(replies);
      if (step === MAX_STEPS - 1) this.feed('system', `Paused after ${MAX_STEPS} tool steps. Say "continue" to keep going.`);
    }
    if (this.closed) return;
    this.feed('result', this.stopTurn ? 'Stopped' : `Done in ${Math.round((Date.now() - started) / 1000)}s`);
    this.save();
    this.onTurnEnd();
  }

  private turnFailed(err: unknown) {
    if (this.closed) return;
    this.child?.kill();
    // Drop a half-finished model reply so the next request is valid again.
    while (this.contents.at(-1)?.role === 'model') this.contents.pop();
    this.save();
    if (this.stopTurn || (err instanceof Error && err.name === 'AbortError')) {
      this.feed('result', 'Stopped');
      this.onTurnEnd();
      return;
    }
    const msg = friendlyError(err);
    this.feed('error', msg, { isError: true });
    this.onTurnEnd();
    // The session stays usable: the next message just tries again.
    this.setStatus('idle', clip(msg, 80));
  }

  /** Messages must alternate roles, so a second user message merges into the last one. */
  private addUser(parts: Part[]) {
    const last = this.contents.at(-1);
    if (last?.role === 'user') last.parts.push(...parts);
    else this.contents.push({ role: 'user', parts });
  }

  /**
   * Built once, like the Claude sessions do. Gemini caches the start of each
   * request for free, so a system prompt that changes (the live roster flips
   * every time another session starts a tool) would throw away the cache for
   * the whole chat on every step. The roster is described as "when you
   * started", and hub_roster gives the live one.
   */
  private sysPrompt: string | null = null;

  private systemPrompt() {
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

  /** One streamed model call. Returns the reply's parts, and streams text into the feed as it arrives. */
  private async generate(): Promise<Part[]> {
    const key = this.host.geminiKey();
    if (!key) throw new Error('No Gemini API key. Add one in Settings.');
    this.abort = new AbortController();
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: this.systemPrompt() }] },
      contents: this.contents,
      tools: [{ functionDeclarations: this.toolDecls() }],
    };
    if (!this.noThinking) body.generationConfig = { thinkingConfig: { includeThoughts: true } };

    const res = await net.fetch(`${API}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: this.abort.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Some models don't think. Retry once without asking for thoughts.
      if (res.status === 400 && !this.noThinking && /thinking/i.test(detail)) {
        this.noThinking = true;
        return this.generate();
      }
      throw new ApiError(res.status, apiMessage(detail) || `HTTP ${res.status}`);
    }

    const base = { ...this.state.tokens };
    const parts: Part[] = [];
    let live: { itemId: string; thought: boolean } | null = null;
    let finish = '';

    for await (const chunk of sse(res)) {
      if (chunk.error) throw new ApiError(chunk.error.code ?? 500, chunk.error.message ?? 'Gemini error');
      if (chunk.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request: ${chunk.promptFeedback.blockReason}`);
      const cand = chunk.candidates?.[0];
      if (cand?.finishReason) finish = cand.finishReason;
      for (const p of (cand?.content?.parts ?? []) as Part[]) {
        if (p.functionCall) {
          live = null;
          parts.push(p);
          continue;
        }
        if (typeof p.text !== 'string') {
          if (p.thoughtSignature) attachSignature(parts, p.thoughtSignature);
          continue;
        }
        const thought = !!p.thought;
        const prev = parts.at(-1);
        if (prev && typeof prev.text === 'string' && !!prev.thought === thought && !prev.functionCall) {
          prev.text += p.text;
          if (p.thoughtSignature && !prev.thoughtSignature) prev.thoughtSignature = p.thoughtSignature;
        } else parts.push({ ...p });
        if (!p.text) continue;
        if (!live || live.thought !== thought) {
          live = { itemId: this.feed(thought ? 'thinking' : 'text', '').id, thought };
          this.setStatus(thought ? 'thinking' : 'working', thought ? 'Thinking' : 'Writing a reply');
        }
        this.host.feedDelta(this.id, live.itemId, p.text);
      }
      if (chunk.usageMetadata) this.count(base, chunk.usageMetadata);
    }

    if (!parts.length && finish && finish !== 'STOP') {
      this.feed('error', `Gemini stopped without an answer (${finish.toLowerCase().replace(/_/g, ' ')}).`, { isError: true });
    }
    return parts;
  }

  protected toolDecls() {
    const files = this.readOnly ? FILE_TOOLS.filter((d) => d.name !== 'write_file' && d.name !== 'edit_file') : FILE_TOOLS;
    return [
      ...files,
      ...(this.config.awareness === 'solo' ? [] : HUB_TOOLS),
      ...(this.host.memoryOn() ? MEMORY_DECLS : []),
      ...(this.host.canSpawn(this.id) ? [SPAWN_DECL] : []),
    ];
  }

  private count(base: SessionTokens, u: Usage) {
    const cached = u.cachedContentTokenCount ?? 0;
    if (!this.costBase || this.costBase.tokens !== base) this.costBase = { tokens: base, usd: this.state.costUsd };
    const price = geminiPrice(this.model);
    const input = Math.max(0, (u.promptTokenCount ?? 0) - cached);
    const output = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
    // Usage numbers in a stream are running totals for this request, so cost starts from the request's base too.
    this.state.costUsd = this.costBase.usd + (input * price.input + cached * price.input * 0.25 + output * price.output) / 1_000_000;
    this.state.tokens = {
      input: base.input + Math.max(0, (u.promptTokenCount ?? 0) - cached),
      output: base.output + (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      cacheRead: base.cacheRead + cached,
      cacheWrite: base.cacheWrite,
    };
    this.publish();
  }

  // ---------- tools ----------

  private async runTool(name: string, args: Record<string, unknown>): Promise<{ result?: string; error?: string }> {
    const { toolName, input } = asClaudeTool(name, args);
    const line = describeTool(toolName, input);
    const toolUseId = newItemId();
    this.feed('tool', line, { toolName, toolUseId, input });
    if (this.state.status !== 'blocked') this.setStatus('working', line);
    let out: { result?: string; error?: string };
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

  private async tool(name: string, a: Record<string, unknown>, toolName: string, input: Record<string, unknown>): Promise<{ result?: string; error?: string }> {
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

  private shell(command: string): Promise<{ result?: string; error?: string }> {
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

  /** Old tool outputs get cut down once the chat gets long, so each turn stays cheap. */
  private trimHistory() {
    let size = JSON.stringify(this.contents).length;
    if (size < HISTORY_SOFT_LIMIT) return;
    for (const c of this.contents.slice(0, -8)) {
      for (const p of c.parts) {
        const r = p.functionResponse?.response;
        if (r && typeof r.result === 'string' && r.result.length > 300) {
          size -= r.result.length;
          r.result = r.result.slice(0, 200) + '\n[old output trimmed]';
        }
      }
      if (size < HISTORY_SOFT_LIMIT * 0.6) break;
    }
  }

  private historyFile() {
    return path.join(this.host.dataDir, 'gemini', `${(this.state.sdkSessionId ?? this.id).replace(/[^\w-]/g, '_')}.json`);
  }

  private save() {
    if (!this.host.dataDir) return;
    try {
      const file = this.historyFile();
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify({ model: this.model, contents: this.contents }));
    } catch {
      /* history is a nice-to-have */
    }
  }

  private loadHistory() {
    try {
      const saved = JSON.parse(fs.readFileSync(this.historyFile(), 'utf8')) as { contents: Content[] };
      this.contents = saved.contents ?? [];
      for (const c of this.contents) {
        for (const p of c.parts) {
          if (p.text && !p.thought && !p.text.startsWith('[Sinnect hub]')) this.feed(c.role === 'user' ? 'user' : 'text', p.text);
          else if (p.functionCall) {
            const t = asClaudeTool(p.functionCall.name, p.functionCall.args ?? {});
            this.feed('tool', describeTool(t.toolName, t.input), { toolName: t.toolName, input: t.input });
          }
        }
      }
      this.feed('system', 'Resumed from your workspace');
    } catch {
      this.feed('system', 'Could not find the earlier chat, starting fresh');
    }
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

type SessionTokens = GeminiSession['state']['tokens'];

/**
 * Rough paid-tier price per million tokens. Free keys pay nothing, but without
 * a number here the board budget and the helper spend cap would never stop a
 * Gemini session. Cached input is billed at a quarter of the input price.
 */
export function geminiPrice(model: string): { input: number; output: number } {
  const m = model.toLowerCase();
  if (/lite/.test(m)) return { input: 0.1, output: 0.4 };
  if (/pro/.test(m)) return /gemini-[3-9]/.test(m) ? { input: 2, output: 12 } : { input: 1.25, output: 10 };
  if (/gemini-2\.0/.test(m)) return { input: 0.1, output: 0.4 };
  return { input: 0.3, output: 2.5 };
}

/** Ask Google which chat models this key can use. */
export async function listGeminiModels(key: string): Promise<{ id: string; label: string }[]> {
  const res = await net.fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw new Error(apiMessage(await res.text().catch(() => '')) || `HTTP ${res.status}`);
  const data = (await res.json()) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
  return (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }))
    .filter((m) => /^gemini/.test(m.id) && !/embed|tts|image|live|audio|vision|aqa|robotics|computer-use|native/i.test(m.id))
    .sort((a, b) => rank(a.id) - rank(b.id));
}

/** Moving "-latest" aliases first, then newest versions. */
function rank(id: string) {
  if (id.endsWith('-latest')) return -1000;
  const v = parseFloat(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? '0');
  return -v * 10 + (/preview|exp/.test(id) ? 1 : 0);
}

async function* sse(res: Response): AsyncGenerator<any> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
    buf += decoder.decode(chunk, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0 || (i = buf.indexOf('\r\n\r\n')) >= 0) {
      const event = buf.slice(0, i);
      buf = buf.slice(i + (buf.startsWith('\r\n\r\n', i) ? 4 : 2));
      const data = event
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('');
      if (data) yield JSON.parse(data);
    }
  }
  const rest = buf.trim().replace(/^data:\s*/, '');
  if (rest) yield JSON.parse(rest);
}

function attachSignature(parts: Part[], sig: string) {
  const last = parts.at(-1);
  if (last && !last.thoughtSignature) last.thoughtSignature = sig;
  else parts.push({ text: '', thoughtSignature: sig });
}

function apiMessage(body: string) {
  try {
    return (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? '';
  } catch {
    return clip(body, 300);
  }
}

function friendlyError(err: unknown) {
  if (err instanceof Error && err.name === 'AbortError') return 'Stopped';
  if (err instanceof ApiError) {
    if (err.status === 429) return `Gemini rate limit hit (the free key has per-minute and per-day limits). Wait a bit and send again. ${clip(err.message, 160)}`;
    if (err.status === 400 && /api key/i.test(err.message)) return 'Gemini says the API key is not valid. Check it in Settings.';
    if (err.status === 403) return `Gemini refused the key: ${clip(err.message, 200)}`;
    if (err.status === 404) return `Gemini doesn't know this model. Pick another one. ${clip(err.message, 160)}`;
    return `Gemini error ${err.status}: ${clip(err.message, 300)}`;
  }
  return err instanceof Error ? err.message : String(err);
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
