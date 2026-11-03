// The engine: owns every session, the Hub, prompts and settings, and talks to
// the UI over a local WebSocket.

import fs from 'node:fs';
import path from 'node:path';
import { Hub } from './hub.js';
import { BaseSession, type SessionHost } from './session.js';
import { RealSession } from './real-session.js';
import { MockSession } from './mock-session.js';
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
  Snapshot,
  WorkspaceInfo,
} from './protocol.js';

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
  private settings: EngineSettings;
  private key: string | null = null;
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
      budgetUsd: 0,
      claudePath: null,
      ...saved,
      hasApiKey: false,
      mock: opts.mock,
    };
    this.key = process.env.MURMUR_API_KEY || this.readJson<{ apiKey?: string }>('secrets.json')?.apiKey || null;
    this.settings.hasApiKey = !!this.key;

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
    };
  }

  private host(): SessionHost {
    return {
      hub: this.hub,
      settings: () => this.settings,
      apiKey: () => this.key,
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
    if (!this.opts.mock && this.settings.authMode === 'apiKey' && !this.key) {
      this.send({ t: 'toast', level: 'error', text: 'Add an API key in Settings, or switch to local login.' });
      return;
    }
    const Ctor = this.opts.mock ? MockSession : RealSession;
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
      case 'settings.set': {
        const { apiKey, ...rest } = msg.patch;
        if (apiKey !== undefined) {
          this.key = apiKey.trim() || null;
          this.writeJson('secrets.json', { apiKey: this.key });
        }
        Object.assign(this.settings, rest, { hasApiKey: !!this.key });
        const { hasApiKey: _h, mock: _m, ...persist } = this.settings;
        this.writeJson('settings.json', persist);
        return this.send({ t: 'settings', settings: this.settings });
      }
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
