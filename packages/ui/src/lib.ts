import { DEFAULT_OPENAI_MODELS, openaiLabel, providerOf, type EngineSettings, type SessionStatus } from '@engine/protocol';

export const STATUS: Record<SessionStatus, { label: string; color: string }> = {
  starting: { label: 'Starting', color: 'var(--color-st-starting)' },
  thinking: { label: 'Thinking', color: 'var(--color-st-thinking)' },
  working: { label: 'Working', color: 'var(--color-st-working)' },
  waiting: { label: 'Needs you', color: 'var(--color-st-waiting)' },
  blocked: { label: 'Waiting on a file', color: 'var(--color-st-blocked)' },
  idle: { label: 'Idle', color: 'var(--color-st-idle)' },
  stopped: { label: 'Stopped', color: 'var(--color-st-stopped)' },
  error: { label: 'Error', color: 'var(--color-st-error)' },
};

export const FAMILY_COLORS = ['#ff6b4a', '#2dd4bf', '#fbbf24', '#7dd3fc', '#f472b6', '#a3e635', '#fb923c', '#e2e8f0'];

export const uid = (p = 's') => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export function compact(n: number) {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function money(n: number) {
  if (n === 0) return '$0';
  if (n < 0.01) return '<$0.01';
  return `$${n.toFixed(2)}`;
}

export function shortPath(p: string) {
  return p.split(/[\\/]/).filter(Boolean).slice(-2).join('/');
}

export function modelLabel(id: string) {
  if (/^(models\/)?gemini/i.test(id)) {
    const bits = id.replace(/^models\//, '').replace(/-\d{2}-\d{4}$/, '').split('-');
    // "-latest" aliases read as plain "Gemini Flash" on the card, the picker spells them out.
    if (bits.at(-1) === 'latest') bits.pop();
    return bits.map((b) => (/^\d/.test(b) ? b : b[0].toUpperCase() + b.slice(1))).join(' ').replace('Flash Lite', 'Flash-Lite');
  }
  if (providerOf(id) === 'openai') return openaiLabel(id);
  const m = /claude-(\w+)-(\d+)-(\d+)/.exec(id);
  if (!m) return id.replace(/^claude-/, '');
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}.${m[3]}`;
}

export const spring = { type: 'spring' as const, stiffness: 420, damping: 34, mass: 0.9 };
export const softSpring = { type: 'spring' as const, stiffness: 260, damping: 30 };

/** The OpenAI models a new session can pick, for the sign-in in use (ChatGPT plan or API key). */
export function openaiModelList(s: EngineSettings | null | undefined): { id: string; label: string }[] {
  if (s?.openaiAuth === 'chatgpt') return s.chatgpt?.models?.length ? s.chatgpt.models : DEFAULT_OPENAI_MODELS;
  return s?.openaiModels?.length ? s.openaiModels : DEFAULT_OPENAI_MODELS;
}

/** OpenAI sessions can start right now. */
export function openaiReady(s: EngineSettings | null | undefined): boolean {
  if (!s) return false;
  if (s.mock) return true;
  return s.openaiAuth === 'chatgpt' ? !!s.chatgpt?.signedIn : s.hasOpenaiKey;
}
