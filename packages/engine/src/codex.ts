// "My ChatGPT account" mode for OpenAI sessions. Sinnect never touches the
// ChatGPT login itself: it runs OpenAI's own Codex app (the same one the
// Codex IDE extension uses) through its official app-server protocol. Codex
// handles the sign-in, keeps the tokens, and bills the user's ChatGPT plan.
//
// This file finds the Codex binary, speaks the app-server JSON-RPC protocol
// (one JSON message per line over stdin/stdout), and checks the sign-in.

import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openaiLabel, type ChatgptStatus } from './protocol.js';
import { safeWebUrl } from './guard.js';

type Pending = { resolve: (v: any) => void; reject: (e: Error) => void };
export type ServerRequestHandler = (method: string, params: any) => Promise<unknown>;

export class CodexRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** One running `codex app-server` and the JSON-RPC conversation with it. */
export class CodexClient {
  private child: ChildProcess;
  private buf = '';
  private seq = 0;
  private pending = new Map<number, Pending>();
  private closed = false;
  /** Notifications from Codex (no reply expected). */
  onNotify: (method: string, params: any) => void = () => {};
  /** Requests from Codex (approvals, tool calls). Whatever it resolves with is the reply. */
  onRequest: ServerRequestHandler = async () => {
    throw new CodexRpcError(-32601, 'Not supported by Sinnect');
  };
  onExit: (why: string) => void = () => {};
  private stderr = '';

  constructor(bin: string, env: NodeJS.ProcessEnv = process.env) {
    const shell = /\.(cmd|bat)$/i.test(bin);
    this.child = spawn(shell ? `"${bin}"` : bin, ['app-server'], { stdio: ['pipe', 'pipe', 'pipe'], env, windowsHide: true, shell });
    this.child.stdout!.setEncoding('utf8');
    this.child.stdout!.on('data', (d: string) => this.read(d));
    this.child.stderr!.on('data', (d: Buffer) => {
      this.stderr = (this.stderr + d.toString()).slice(-4000);
    });
    this.child.on('error', (e) => this.fail(e.message));
    this.child.on('exit', (code) => this.fail(code ? `Codex exited (code ${code}). ${lastLine(this.stderr)}` : 'Codex closed'));
  }

  /** Must be called first. Turns on the experimental fields Sinnect needs (its own tools). */
  async initialize(version: string) {
    const r = await this.request('initialize', { clientInfo: { name: 'sinnect', title: 'Sinnect', version }, capabilities: { experimentalApi: true } });
    this.notify('initialized');
    return r;
  }

  request<T = any>(method: string, params: unknown = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex is not running'));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write({ id, method, params });
    });
  }

  notify(method: string, params?: unknown) {
    this.write(params === undefined ? { method } : { method, params });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    try {
      this.child.stdin?.end();
      this.child.kill();
    } catch {
      /* already gone */
    }
    for (const p of this.pending.values()) p.reject(new Error('Codex closed'));
    this.pending.clear();
  }

  private write(msg: unknown) {
    if (this.closed) return;
    try {
      this.child.stdin!.write(JSON.stringify(msg) + '\n');
    } catch {
      /* the exit handler reports it */
    }
  }

  private read(chunk: string) {
    this.buf += chunk;
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.method && msg.id !== undefined) this.answer(msg.id, msg.method, msg.params);
      else if (msg.method) this.onNotify(msg.method, msg.params);
      else if (msg.id !== undefined) {
        const p = this.pending.get(msg.id);
        if (!p) continue;
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new CodexRpcError(msg.error.code ?? -1, msg.error.message ?? 'Codex error'));
        else p.resolve(msg.result);
      }
    }
  }

  private answer(id: number | string, method: string, params: any) {
    this.onRequest(method, params).then(
      (result) => this.write({ id, result }),
      (e) => this.write({ id, error: { code: e instanceof CodexRpcError ? e.code : -32000, message: e instanceof Error ? e.message : String(e) } }),
    );
  }

  private fail(why: string) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error(why));
    this.pending.clear();
    this.onExit(why);
  }
}

function lastLine(s: string) {
  return s.trim().split(/\r?\n/).filter((l) => !/WARN|bubblewrap/i.test(l)).at(-1)?.replace(/\x1b\[[0-9;]*m/g, '').slice(0, 200) ?? '';
}

// ---------- finding Codex ----------

/** The Codex binary: the one picked in Settings, else on PATH, else the usual install spots. */
export function findCodex(picked: string | null): string | null {
  if (picked && fs.existsSync(picked)) return picked;
  const names = process.platform === 'win32' ? ['codex.exe', 'codex.cmd'] : ['codex'];
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const home = os.homedir();
  if (process.platform === 'win32') {
    if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, 'npm'));
    if (process.env.LOCALAPPDATA) dirs.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'codex'), path.join(process.env.LOCALAPPDATA, 'Programs', 'OpenAI', 'Codex'));
  } else {
    dirs.push('/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local', 'bin'), path.join(home, '.npm-global', 'bin'), path.join(home, '.volta', 'bin'));
  }
  for (const d of dirs) {
    for (const n of names) {
      const f = path.join(d, n);
      try {
        if (fs.statSync(f).isFile()) return f;
      } catch {
        /* not here */
      }
    }
  }
  return null;
}

/** Ask Codex who is signed in, which models the plan has, and how much of the plan is used. */
export async function probeCodex(bin: string, version: string): Promise<ChatgptStatus> {
  const c = new CodexClient(bin);
  const timer = setTimeout(() => c.close(), 20_000);
  try {
    const init = await c.initialize(version);
    const acct = (await c.request('account/read', {})) as { account: { type: string; email?: string | null; planType?: string } | null };
    const signedIn = acct.account?.type === 'chatgpt';
    const status: ChatgptStatus = {
      found: true,
      path: bin,
      version: /\/(\d+\.\d+\.\d+)/.exec(String(init?.userAgent ?? ''))?.[1] ?? null,
      signedIn,
      email: signedIn ? (acct.account?.email ?? null) : null,
      plan: signedIn ? (acct.account?.planType ?? null) : null,
      models: [],
      usage: null,
    };
    if (signedIn) {
      const [models, limits] = await Promise.allSettled([c.request('model/list', {}), c.request('account/rateLimits/read', {})]);
      if (models.status === 'fulfilled') status.models = codexModels(models.value);
      if (limits.status === 'fulfilled') status.usage = planUsage(limits.value?.rateLimits);
    }
    return status;
  } finally {
    clearTimeout(timer);
    c.close();
  }
}

export function codexModels(res: any): { id: string; label: string }[] {
  return ((res?.data ?? []) as { id: string; displayName?: string; hidden?: boolean }[])
    .filter((m) => !m.hidden)
    .map((m) => ({ id: m.id, label: m.displayName ? m.displayName.replace(/^GPT-(\S+?)-/, 'GPT-$1 ') : openaiLabel(m.id) }));
}

/** The plan's usage windows (like "5 hours" and "week") as percentages. */
export function planUsage(snap: any): ChatgptStatus['usage'] {
  if (!snap) return null;
  const win = (w: any) => (w && typeof w.usedPercent === 'number' ? { usedPercent: w.usedPercent, windowMins: w.windowDurationMins ?? null, resetsAt: w.resetsAt ?? null } : null);
  const primary = win(snap.primary);
  const secondary = win(snap.secondary);
  if (!primary && !secondary) return null;
  return { primary, secondary, reached: !!snap.rateLimitReachedType };
}

/**
 * Starts the ChatGPT sign-in. Codex opens a small local server for the
 * callback, so its process stays alive until the sign-in finishes.
 * Resolves with the URL to open in the browser.
 */
export async function startChatgptLogin(bin: string, version: string, done: (ok: boolean, error: string | null) => void): Promise<string> {
  const c = new CodexClient(bin);
  let finished = false;
  const finish = (ok: boolean, err: string | null) => {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    c.close();
    done(ok, err);
  };
  const timer = setTimeout(() => finish(false, 'Sign-in timed out'), 10 * 60_000);
  c.onNotify = (method, params) => {
    if (method === 'account/login/completed') finish(!!params?.success, params?.error ?? null);
  };
  c.onExit = (why) => finish(false, why);
  try {
    await c.initialize(version);
    const r = (await c.request('account/login/start', { type: 'chatgpt' })) as { authUrl?: string };
    if (!r.authUrl) throw new Error('Codex did not return a sign-in link');
    return r.authUrl;
  } catch (e) {
    finish(false, e instanceof Error ? e.message : String(e));
    throw e;
  }
}

/** Opens a link in the default browser. */
export function openUrl(raw: string) {
  // The link ends up on a command line, so only a clean http(s) link gets through.
  const url = safeWebUrl(raw);
  if (!url) return;
  if (process.platform === 'win32') spawn('cmd.exe', ['/c', 'start', '""', `"${url}"`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true, windowsHide: true }).unref();
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

/** Opens a terminal that installs Codex with npm, the way OpenAI's docs say to. */
export function openCodexInstall(): string | null {
  const cmd = 'npm install -g @openai/codex';
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', `start "Install Codex" cmd /k "${cmd} && echo. && echo Done. You can close this window and go back to Sinnect."`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    } else if (process.platform === 'darwin') {
      spawn('osascript', ['-e', `tell application "Terminal" to do script "${cmd}"`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', `sh -c '${cmd}; read x'`], { detached: true, stdio: 'ignore' }).unref();
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
