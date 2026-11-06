// The engine: owns every session, the Hub, prompts and settings, and talks to
// the UI over a local WebSocket.

import fs from 'node:fs';
import path from 'node:path';
import { Hub } from './hub.js';
import { BaseSession, type SessionHost } from './session.js';
import { RealSession } from './real-session.js';
import { MockSession } from './mock-session.js';
import { GeminiSession, listGeminiModels } from './gemini-session.js';
import { isSignedIn, openLogin } from './auth.js';
import { commitTemplates, demoTemplates, loadTemplates, upsertTemplate } from './templates.js';
import type {
  ClientMsg,
  EngineMsg,
  EngineSettings,
  Family,
  FeedItem,
  HubMessage,
  Link,
  PromptRequest,
  PromptResponse,
  SessionConfig,
  SessionTemplate,
  Snapshot,
  WorkspaceInfo,
} from './protocol.js';
import { DEFAULT_GEMINI_MODELS, providerOf } from './protocol.js';

const FEED_LIMIT = 1500;

export interface EngineOptions {
  dataDir: string;
  mock: boolean;
  broadcast(msg: EngineMsg): void;
}

export class Engine {
  private sessions = new Map<string, BaseSession>();
  private feeds = new Map<string, FeedItem[]>();
  private prompts = new Map<string, { req: PromptRequest; resolve: (r: PromptResponse) => void }>();
  private links: Link[] = [];
  private families: Family[] = [];
  private templates: SessionTemplate[] = [];
  private settings: EngineSettings;
  private key: string | null = null;
  private geminiKey: string | null = null;
  private loginWatch: ReturnType<typeof setInterval> | undefined;
  readonly hub: Hub;

  constructor(private opts: EngineOptions) {
    fs.mkdirSync(path.join(opts.dataDir, 'workspaces'), { recursive: true });
    const saved = this.readJson<Partial<EngineSettings>>('settings.json') ?? {};
    this.settings = {
      authMode: 'local',
      defaultModel: 'claude-sonnet-5-5',
      maxMessageChars: 500,
      maxMessagesPerHour: 30,
      maxNegotiationRounds: 2,
      maxWakeChain: 2,
      maxWakesPerHour: 8,
      budgetUsd: 0,
      claudePath: null,
      notify: true,
      ...saved,
      hasApiKey: false,
      hasGeminiKey: false,
      geminiModels: DEFAULT_GEMINI_MODELS,
      signedIn: opts.mock || isSignedIn(),
      mock: opts.mock,
    };
    this.templates = loadTemplates(opts.dataDir);
    if (opts.mock && !this.templates.length) this.templates = demoTemplates();
    const secrets = this.readJson<{ apiKey?: string | null; geminiKey?: string | null }>('secrets.json') ?? {};
    this.key = process.env.SINNECT_API_KEY || secrets.apiKey || null;
    this.geminiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || secrets.geminiKey || null;
    this.settings.hasApiKey = !!this.key;
    this.settings.hasGeminiKey = !!this.geminiKey;
    if (this.geminiKey && !opts.mock) this.refreshGeminiModels();

    this.hub = new Hub({
      sessions: () =>
        [...this.sessions.values()]
          .filter((s) => s.state.status !== 'stopped')
          .map((s) => ({
            id: s.id,
            name: s.config.name,
            priority: s.config.priority,
            familyId: s.config.familyId ?? null,
            awareness: s.config.awareness,
            goal: s.state.goal,
            status: s.state.status,
            activity: s.state.activity,
          })),
      links: () => this.links,
      limits: () => this.settings,
      deliver: (msg, wake) => this.sessions.get(msg.to)?.deliver(msg, wake),
      openPrompt: (p) => this.openPrompt(p),
      closePrompt: (id) => this.closePrompt(id),
      claimsChanged: (claims) => this.send({ t: 'claims', claims }),
      messageLogged: (message: HubMessage) => this.send({ t: 'hub.message', message }),
    });
  }

  private send(msg: EngineMsg) {
    this.opts.broadcast(msg);
  }

  /** Re-checks the Claude Code login and tells the UI if it changed. */
  private refreshSignIn(): boolean {
    const now = this.opts.mock || isSignedIn();
    if (now !== this.settings.signedIn) {
      this.settings.signedIn = now;
      this.send({ t: 'settings', settings: this.settings });
    }
    return now;
  }

  /** Ask Google which Gemini models this key can use, so the picker never offers a dead one. */
  private refreshGeminiModels() {
    const key = this.geminiKey;
    if (!key) return;
    listGeminiModels(key)
      .then((models) => {
        if (key !== this.geminiKey || !models.length) return;
        this.settings.geminiModels = models;
        this.send({ t: 'settings', settings: this.settings });
      })
      .catch((e) => this.send({ t: 'toast', level: 'warn', text: `Gemini key check failed: ${e instanceof Error ? e.message : e}` }));
  }

  private readJson<T>(file: string): T | null {
    try {
      return JSON.parse(fs.readFileSync(path.join(this.opts.dataDir, file), 'utf8')) as T;
    } catch {
      return null;
    }
  }
  private writeJson(file: string, data: unknown) {
    const full = path.join(this.opts.dataDir, file);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full + '.tmp', JSON.stringify(data, null, 2));
    fs.renameSync(full + '.tmp', full);
  }

  snapshot(): Snapshot {
    return {
      sessions: [...this.sessions.values()].map((s) => s.state),
      feeds: Object.fromEntries(this.feeds),
      claims: this.hub.allClaims(),
      links: this.links,
      families: this.families,
      prompts: [...this.prompts.values()].map((p) => p.req),
      messages: this.hub.log.slice(-300),
      settings: this.settings,
      templates: this.templates,
    };
  }

  private host(): SessionHost {
    return {
      hub: this.hub,
      settings: () => this.settings,
      apiKey: () => this.key,
      geminiKey: () => this.geminiKey,
      dataDir: this.opts.dataDir,
      state: (state) => this.send({ t: 'session.state', state }),
      feedAdd: (id, item) => {
        const feed = this.feeds.get(id) ?? [];
        feed.push(item);
        if (feed.length > FEED_LIMIT) feed.splice(0, feed.length - FEED_LIMIT);
        this.feeds.set(id, feed);
        this.send({ t: 'feed.add', id, item });
      },
      feedDelta: (id, itemId, text) => {
        const feed = this.feeds.get(id);
        const item = feed?.findLast((i) => i.id === itemId);
        if (item) item.text += text;
        this.send({ t: 'feed.delta', id, itemId, text });
      },
      ask: (req) =>
        new Promise<PromptResponse>((resolve) => {
          this.prompts.set(req.requestId, { req, resolve });
          this.send({ t: 'prompt.open', prompt: req });
        }),
      nameOf: (id) => this.sessions.get(id)?.config.name ?? id,
      turnDone: () => this.checkBudget(),
    };
  }

  private openPrompt(req: PromptRequest) {
    // Hub prompts (negotiations) are answered through hub.decide, not a promise.
    this.prompts.set(req.requestId, { req, resolve: () => {} });
    this.send({ t: 'prompt.open', prompt: req });
  }

  private closePrompt(requestId: string) {
    if (this.prompts.delete(requestId)) this.send({ t: 'prompt.close', requestId });
  }

  private checkBudget() {
    const budget = this.settings.budgetUsd;
    if (!budget) return;
    const total = [...this.sessions.values()].reduce((a, s) => a + s.state.costUsd, 0);
    if (total >= budget) {
      for (const s of this.sessions.values()) if (s.state.status !== 'idle' && s.state.status !== 'stopped') s.interrupt().catch(() => {});
      this.send({ t: 'toast', level: 'warn', text: `Budget of $${budget.toFixed(2)} reached. Sessions were paused.` });
    }
  }

  createSession(id: string, config: SessionConfig) {
    if (this.sessions.has(id)) return;
    const cfg: SessionConfig = {
      ...config,
      priority: Math.min(5, Math.max(1, Math.round(config.priority || 3))),
      model: config.model || this.settings.defaultModel,
    };
    if (!this.opts.mock && !fs.existsSync(cfg.cwd)) {
      this.send({ t: 'toast', level: 'error', text: `Folder not found: ${cfg.cwd}` });
      return;
    }
    const gemini = providerOf(cfg.model) === 'gemini';
    if (!this.opts.mock && gemini && !this.geminiKey) {
      this.send({ t: 'toast', level: 'error', text: 'Add a Gemini API key in Settings first. It is free at aistudio.google.com.' });
      return;
    }
    if (!this.opts.mock && !gemini && this.settings.authMode === 'apiKey' && !this.key) {
      this.send({ t: 'toast', level: 'error', text: 'Add an API key in Settings, or switch to local login.' });
      return;
    }
    const Ctor = this.opts.mock ? MockSession : gemini ? GeminiSession : RealSession;
    const s = new Ctor(id, cfg, this.host());
    this.sessions.set(id, s);
    this.feeds.set(id, []);
    this.send({ t: 'session.state', state: s.state });
    try {
      s.start();
    } catch (err) {
      this.send({ t: 'toast', level: 'error', text: `Could not start ${cfg.name}: ${err instanceof Error ? err.message : err}` });
    }
  }

  async handle(msg: ClientMsg) {
    switch (msg.t) {
      case 'snapshot':
        return this.send({ t: 'ready', snapshot: this.snapshot() });
      case 'session.create':
        return this.createSession(msg.id, msg.config);
      case 'session.send':
        return this.sessions.get(msg.id)?.send(msg.text);
      case 'session.interrupt':
        return this.sessions.get(msg.id)?.interrupt();
      case 'session.stop':
        return this.sessions.get(msg.id)?.stop();
      case 'session.remove': {
        const s = this.sessions.get(msg.id);
        if (s) await s.stop();
        for (const [rid, p] of this.prompts) {
          if (p.req.sessionId === msg.id) {
            p.resolve(p.req.kind === 'question' ? { requestId: rid, kind: 'question', answers: {}, skipped: true } : { requestId: rid, kind: 'tool', decision: 'deny' });
            this.closePrompt(rid);
          }
        }
        this.sessions.delete(msg.id);
        this.feeds.delete(msg.id);
        this.links = this.links.filter((l) => l.a !== msg.id && l.b !== msg.id);
        this.send({ t: 'session.removed', id: msg.id });
        this.send({ t: 'links', links: this.links });
        return;
      }
      case 'session.update':
        return this.sessions.get(msg.id)?.updateConfig(msg.patch);
      case 'prompt.respond': {
        const r = msg.response;
        const p = this.prompts.get(r.requestId);
        if (!p) return;
        if (r.kind === 'negotiation') this.hub.decide(r.requestId, r.winner);
        else p.resolve(r);
        this.closePrompt(r.requestId);
        return;
      }
      case 'links.set':
        this.links = msg.links;
        return this.send({ t: 'links', links: this.links });
      case 'families.set':
        this.families = msg.families;
        return this.send({ t: 'families', families: this.families });
      case 'auth.check':
        return this.refreshSignIn();
      case 'auth.login': {
        const err = openLogin(this.settings.claudePath);
        if (err) return this.send({ t: 'toast', level: 'error', text: `Couldn't open the sign-in window: ${err}` });
        this.send({ t: 'toast', level: 'info', text: 'Finish signing in in the window that just opened.' });
        // Watch for the login to land, for up to 5 minutes.
        clearInterval(this.loginWatch);
        let ticks = 0;
        this.loginWatch = setInterval(() => {
          if (this.refreshSignIn() || ++ticks > 150) clearInterval(this.loginWatch);
        }, 2000);
        return;
      }
      case 'settings.set': {
        const { apiKey, geminiKey, ...rest } = msg.patch;
        if (apiKey !== undefined) this.key = apiKey.trim() || null;
        if (geminiKey !== undefined) {
          this.geminiKey = geminiKey.trim() || null;
          this.settings.geminiModels = DEFAULT_GEMINI_MODELS;
          this.refreshGeminiModels();
        }
        if (apiKey !== undefined || geminiKey !== undefined) this.writeJson('secrets.json', { apiKey: this.key, geminiKey: this.geminiKey });
        const loose = rest as Partial<EngineSettings>;
        delete loose.signedIn;
        delete loose.hasGeminiKey;
        delete loose.geminiModels;
        Object.assign(this.settings, rest, { hasApiKey: !!this.key, hasGeminiKey: !!this.geminiKey });
        const { hasApiKey: _h, hasGeminiKey: _g, geminiModels: _gm, mock: _m, signedIn: _s, ...persist } = this.settings;
        this.writeJson('settings.json', persist);
        return this.send({ t: 'settings', settings: this.settings });
      }
      case 'template.save': {
        const r = upsertTemplate(this.templates, msg.template);
        if (!r.ok) return this.rejectTemplate(r.error);
        return this.persistTemplates(r.list);
      }
      case 'template.delete':
        return this.persistTemplates(this.templates.filter((t) => t.id !== msg.id));
      case 'workspace.save':
        this.writeJson(path.join('workspaces', safeName(msg.name) + '.json'), { savedAt: Date.now(), data: msg.data });
        if (!msg.name.startsWith('__')) this.send({ t: 'workspace.list', items: this.listWorkspaces() });
        return;
      case 'workspace.list':
        return this.send({ t: 'workspace.list', items: this.listWorkspaces() });
      case 'workspace.load': {
        const w = this.readJson<{ data: unknown }>(path.join('workspaces', safeName(msg.name) + '.json'));
        return this.send({ t: 'workspace.data', name: msg.name, data: w?.data ?? null });
      }
      case 'workspace.delete':
        try {
          fs.unlinkSync(path.join(this.opts.dataDir, 'workspaces', safeName(msg.name) + '.json'));
        } catch {
          /* gone already */
        }
        return this.send({ t: 'workspace.list', items: this.listWorkspaces() });
    }
  }

  /** The UI saves optimistically, so a rejection must resend the real list. */
  private rejectTemplate(error: string) {
    this.send({ t: 'toast', level: 'error', text: error });
    this.send({ t: 'templates', templates: this.templates });
  }

  private persistTemplates(next: SessionTemplate[]) {
    const r = commitTemplates(this.templates, next, (list) => this.writeJson('templates.json', list));
    this.templates = r.list;
    if (r.error) this.send({ t: 'toast', level: 'error', text: `Could not save templates: ${r.error}` });
    this.send({ t: 'templates', templates: this.templates });
  }

  private listWorkspaces(): WorkspaceInfo[] {
    const dir = path.join(this.opts.dataDir, 'workspaces');
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        const w = this.readJson<{ savedAt: number; data: { sessions?: unknown[] } }>(path.join('workspaces', f));
        return { name: f.slice(0, -5), savedAt: w?.savedAt ?? 0, sessions: w?.data?.sessions?.length ?? 0 };
      })
      .sort((a, b) => b.savedAt - a.savedAt);
  }

  async shutdown() {
    await Promise.all([...this.sessions.values()].map((s) => s.stop()));
  }
}

function safeName(name: string) {
  return name.replace(/[^\w\- ]+/g, '_').slice(0, 80) || 'workspace';
}
