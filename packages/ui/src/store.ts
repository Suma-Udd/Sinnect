import { create } from 'zustand';
import type { Edge, Node, Viewport } from '@xyflow/react';
import type {
  Claim,
  EngineMsg,
  EngineSettings,
  Family,
  FeedItem,
  HubMessage,
  Link,
  MemoryNote,
  PromptRequest,
  SessionState,
  SessionTemplate,
  WorkspaceInfo,
} from '@engine/protocol';

export type ConnState = 'connecting' | 'open' | 'closed';

export interface SessionNodeData extends Record<string, unknown> {
  sessionId: string;
}
export interface FamilyNodeData extends Record<string, unknown> {
  familyId: string;
}
export interface NoteNodeData extends Record<string, unknown> {
  text: string;
}

export type AppNode =
  | Node<SessionNodeData, 'session'>
  | Node<FamilyNodeData, 'family'>
  | Node<NoteNodeData, 'note'>;

export interface Pulse {
  id: string;
  from: string;
  to: string;
  at: number;
}

export interface UiState {
  conn: ConnState;
  settings: EngineSettings | null;
  sessions: Record<string, SessionState>;
  /** Sessions loaded from a workspace that aren't running yet. */
  dormant: Record<string, boolean>;
  feeds: Record<string, FeedItem[]>;
  claims: Claim[];
  links: Link[];
  families: Family[];
  prompts: PromptRequest[];
  messages: HubMessage[];
  pulses: Pulse[];
  workspaces: WorkspaceInfo[];
  workspaceName: string;
  templates: SessionTemplate[];
  memory: MemoryNote[];
  /** Ids of notes for the "Sinnect learned N things" card, newest last. */
  learned: string[];
  memoryOpen: boolean;

  nodes: AppNode[];
  viewport: Viewport | null;

  expanded: string | null;
  expandFrom: DOMRect | null;
  /** `template` prefills the card (one-click spawn that had no folder to use). */
  setup: { position: { x: number; y: number }; familyId: string | null; template?: SessionTemplate } | null;
  settingsOpen: boolean;
  workspacesOpen: boolean;
  paletteOpen: boolean;

  apply(msg: EngineMsg): void;
  set(p: Partial<UiState>): void;
}

const MAX_FEED = 1500;

export const useApp = create<UiState>((set, get) => ({
  conn: 'connecting',
  settings: null,
  sessions: {},
  dormant: {},
  feeds: {},
  claims: [],
  links: [],
  families: [],
  prompts: [],
  messages: [],
  pulses: [],
  workspaces: [],
  workspaceName: 'My workspace',
  templates: [],
  memory: [],
  learned: [],
  memoryOpen: false,
  nodes: [],
  viewport: null,
  expanded: null,
  expandFrom: null,
  setup: null,
  settingsOpen: false,
  workspacesOpen: false,
  paletteOpen: false,

  set: (p) => set(p),

  apply(msg) {
    const s = get();
    switch (msg.t) {
      case 'ready': {
        const snap = msg.snapshot;
        const sessions = { ...s.sessions };
        for (const st of snap.sessions) sessions[st.id] = st;
        const dormant = { ...s.dormant };
        for (const st of snap.sessions) delete dormant[st.id];
        set({
          settings: snap.settings,
          sessions,
          dormant,
          feeds: { ...s.feeds, ...snap.feeds },
          claims: snap.claims,
          links: snap.links.length ? snap.links : s.links,
          families: snap.families.length ? snap.families : s.families,
          prompts: snap.prompts,
          messages: snap.messages,
          templates: snap.templates ?? s.templates,
          memory: snap.memory ?? s.memory,
          // Notes nobody has reviewed yet come back after a restart.
          learned: (snap.memory ?? []).filter((n) => !n.reviewed).map((n) => n.id).slice(-12),
        });
        // Engine knows sessions the canvas has no node for (e.g. after a UI reload): place them.
        const have = new Set(get().nodes.filter((n) => n.type === 'session').map((n) => n.id));
        const missing = snap.sessions.filter((x) => !have.has(x.id));
        if (missing.length) {
          set({
            nodes: [
              ...get().nodes,
              ...missing.map((x, i) => ({
                id: x.id,
                type: 'session' as const,
                position: { x: 120 + (i % 4) * 320, y: 120 + Math.floor(i / 4) * 220 },
                data: { sessionId: x.id },
              })),
            ],
          });
        }
        return;
      }
      case 'session.state':
        set({ sessions: { ...s.sessions, [msg.state.id]: msg.state } });
        return;
      case 'session.removed': {
        const sessions = { ...s.sessions };
        delete sessions[msg.id];
        const feeds = { ...s.feeds };
        delete feeds[msg.id];
        set({
          sessions,
          feeds,
          nodes: s.nodes.filter((n) => n.id !== msg.id),
          expanded: s.expanded === msg.id ? null : s.expanded,
        });
        return;
      }
      case 'feed.add': {
        const feed = [...(s.feeds[msg.id] ?? []), msg.item];
        if (feed.length > MAX_FEED) feed.splice(0, feed.length - MAX_FEED);
        set({ feeds: { ...s.feeds, [msg.id]: feed } });
        return;
      }
      case 'feed.delta':
        // batched in engine.ts, see applyDeltas
        return;
      case 'prompt.open':
        if (s.prompts.some((p) => p.requestId === msg.prompt.requestId)) return;
        set({ prompts: [...s.prompts, msg.prompt] });
        return;
      case 'prompt.close':
        set({ prompts: s.prompts.filter((p) => p.requestId !== msg.requestId) });
        return;
      case 'claims':
        set({ claims: msg.claims });
        return;
      case 'hub.message': {
        const m = msg.message;
        const messages = [...s.messages, m].slice(-500);
        const pulses = m.from !== 'hub' ? [...s.pulses.filter((p) => Date.now() - p.at < 4000), { id: m.id, from: m.from, to: m.to, at: Date.now() }] : s.pulses;
        set({ messages, pulses });
        return;
      }
      case 'links':
        set({ links: msg.links });
        return;
      case 'families':
        set({ families: msg.families });
        return;
      case 'settings':
        set({ settings: msg.settings });
        return;
      case 'templates':
        set({ templates: msg.templates });
        return;
      case 'memory': {
        const ids = new Set(msg.notes.map((n) => n.id));
        const open = new Set(msg.notes.filter((n) => !n.reviewed).map((n) => n.id));
        set({ memory: msg.notes, learned: s.learned.filter((id) => ids.has(id) && open.has(id)) });
        return;
      }
      case 'memory.learned': {
        const add = msg.notes.map((n) => n.id).filter((id) => !s.learned.includes(id));
        set({ learned: [...s.learned, ...add].slice(-12) });
        return;
      }
      case 'workspace.list':
        set({ workspaces: msg.items });
        return;
      default:
        return;
    }
  },
}));

/** Apply a batch of streaming text deltas in one store update. */
export function applyDeltas(batch: Map<string, Map<string, string>>) {
  const s = useApp.getState();
  const feeds = { ...s.feeds };
  for (const [sid, items] of batch) {
    const feed = feeds[sid];
    if (!feed) continue;
    const next = feed.slice();
    for (const [itemId, text] of items) {
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].id === itemId) {
          next[i] = { ...next[i], text: next[i].text + text };
          break;
        }
      }
    }
    feeds[sid] = next;
  }
  useApp.setState({ feeds });
}

export const isActive = (st?: SessionState) =>
  !!st && (st.status === 'thinking' || st.status === 'working' || st.status === 'starting');

export const totalTokens = (st: SessionState) => st.tokens.input + st.tokens.output + st.tokens.cacheWrite;

export const linkEdges = (links: Link[]): Edge[] =>
  links.map((l) => ({ id: l.id, source: l.a, target: l.b, type: 'pulse', sourceHandle: 'out', targetHandle: 'in' }));
