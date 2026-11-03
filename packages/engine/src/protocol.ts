// Shared wire protocol between the Sinnect UI and the engine.
// The UI imports this file directly, so keep it free of Node-only imports.

export type Awareness = 'solo' | 'family' | 'everyone';
export type PermissionChoice = 'ask' | 'acceptEdits' | 'auto';
export type AuthMode = 'apiKey' | 'local';

export interface SessionConfig {
  name: string;
  cwd: string;
  model: string;
  prompt: string;
  /** 1 (lowest) to 5 (highest). Used to settle file conflicts. */
  priority: number;
  awareness: Awareness;
  permission: PermissionChoice;
  familyId?: string | null;
  /** SDK session id to resume instead of starting fresh. */
  resumeId?: string | null;
}

export type SessionStatus =
  | 'starting'
  | 'thinking'
  | 'working'
  | 'waiting' // waiting on the user (permission / question)
  | 'blocked' // waiting on another session (file conflict)
  | 'idle' // turn finished, can take more input
  | 'stopped'
  | 'error';

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface SessionState {
  id: string;
  config: SessionConfig;
  status: SessionStatus;
  /** One short line: what the session is doing right now. Built from tool calls, costs no tokens. */
  activity: string;
  /** The session's own one-line goal, set through hub_set_status. */
  goal: string;
  tokens: TokenUsage;
  costUsd: number;
  sdkSessionId: string | null;
  filesTouched: string[];
  turns: number;
  startedAt: number;
  error?: string;
}

export type FeedKind =
  | 'user'
  | 'text'
  | 'thinking'
  | 'tool'
  | 'tool_result'
  | 'hub'
  | 'system'
  | 'result'
  | 'error';

export interface FeedItem {
  id: string;
  ts: number;
  kind: FeedKind;
  text: string;
  toolName?: string;
  toolUseId?: string;
  input?: unknown;
  isError?: boolean;
}

export interface Claim {
  path: string;
  sessionId: string;
  reason: string;
  since: number;
}

export interface HubMessage {
  id: string;
  ts: number;
  from: string; // session id or 'hub'
  to: string; // session id
  text: string;
  kind: 'message' | 'notice' | 'negotiation';
}

export interface Link {
  id: string;
  a: string;
  b: string;
}

export interface Family {
  id: string;
  name: string;
  color: string;
}

export interface Question {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: { label: string; description?: string }[];
}

export type PromptRequest =
  | {
      kind: 'tool';
      requestId: string;
      sessionId: string;
      toolName: string;
      title: string;
      detail: string;
      canAlwaysAllow: boolean;
    }
  | {
      kind: 'question';
      requestId: string;
      sessionId: string;
      questions: Question[];
    }
  | {
      kind: 'negotiation';
      requestId: string;
      sessionId: string; // the session that asked for the file
      otherId: string; // the session holding the file
      path: string;
      title: string;
      detail: string;
    };

export type PromptResponse =
  | { requestId: string; kind: 'tool'; decision: 'allow' | 'deny' | 'always'; message?: string }
  | { requestId: string; kind: 'question'; answers: Record<string, string>; skipped?: boolean }
  | { requestId: string; kind: 'negotiation'; winner: string };

export interface EngineSettings {
  authMode: AuthMode;
  hasApiKey: boolean;
  defaultModel: string;
  mock: boolean;
  /** Max characters per hub message. */
  maxMessageChars: number;
  /** Max hub messages a session may send per hour. */
  maxMessagesPerHour: number;
  /** Max negotiation rounds before asking the user. */
  maxNegotiationRounds: number;
  /** Stop every session once total spend passes this. 0 = no limit. */
  budgetUsd: number;
  claudePath: string | null;
}

export interface Snapshot {
  sessions: SessionState[];
  feeds: Record<string, FeedItem[]>;
  claims: Claim[];
  links: Link[];
  families: Family[];
  prompts: PromptRequest[];
  messages: HubMessage[];
  settings: EngineSettings;
}

// ---- UI -> engine ----
export type ClientMsg =
  | { t: 'hello'; token: string }
  | { t: 'session.create'; id: string; config: SessionConfig }
  | { t: 'session.send'; id: string; text: string }
  | { t: 'session.interrupt'; id: string }
  | { t: 'session.stop'; id: string }
  | { t: 'session.remove'; id: string }
  | { t: 'session.update'; id: string; patch: Partial<Pick<SessionConfig, 'name' | 'priority' | 'awareness' | 'permission' | 'familyId'>> }
  | { t: 'prompt.respond'; response: PromptResponse }
  | { t: 'links.set'; links: Link[] }
  | { t: 'families.set'; families: Family[] }
  | { t: 'settings.set'; patch: Partial<Omit<EngineSettings, 'hasApiKey' | 'mock'>> & { apiKey?: string } }
  | { t: 'snapshot' }
  | { t: 'workspace.save'; name: string; data: unknown }
  | { t: 'workspace.list' }
  | { t: 'workspace.load'; name: string }
  | { t: 'workspace.delete'; name: string };

// ---- engine -> UI ----
export type EngineMsg =
  | { t: 'ready'; snapshot: Snapshot }
  | { t: 'session.state'; state: SessionState }
  | { t: 'session.removed'; id: string }
  | { t: 'feed.add'; id: string; item: FeedItem }
  | { t: 'feed.delta'; id: string; itemId: string; text: string }
  | { t: 'prompt.open'; prompt: PromptRequest }
  | { t: 'prompt.close'; requestId: string }
  | { t: 'claims'; claims: Claim[] }
  | { t: 'hub.message'; message: HubMessage }
  | { t: 'links'; links: Link[] }
  | { t: 'families'; families: Family[] }
  | { t: 'settings'; settings: EngineSettings }
  | { t: 'toast'; level: 'info' | 'warn' | 'error'; text: string }
  | { t: 'workspace.list'; items: WorkspaceInfo[] }
  | { t: 'workspace.data'; name: string; data: unknown };

export interface WorkspaceInfo {
  name: string;
  savedAt: number;
  sessions: number;
}

export const DEFAULT_MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
];
