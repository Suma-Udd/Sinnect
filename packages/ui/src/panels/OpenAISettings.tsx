import { motion } from 'motion/react';
import { Download, LogIn, RefreshCw } from 'lucide-react';
import type { ChatgptStatus, EngineSettings } from '@engine/protocol';
import { send } from '../engine';
import { spring } from '../lib';
import { KeyRow } from '../components/KeyRow';

/** Settings block: how OpenAI sessions sign in, ChatGPT plan (through Codex) or API key. */
export function OpenAISettings({ settings }: { settings: EngineSettings }) {
  const set = (patch: Record<string, unknown>) => send({ t: 'settings.set', patch });
  const mode = settings.openaiAuth ?? 'chatgpt';
  return (
    <div className="mb-4">
      <div className="mb-2 text-[12px] font-medium text-ink-2">How OpenAI sessions sign in</div>
      <div className="mb-2 flex gap-1 rounded-[12px] border border-line bg-[#1a1a1a] p-1">
        {(['chatgpt', 'apiKey'] as const).map((m) => (
          <button key={m} onClick={() => set({ openaiAuth: m })} className={`relative h-8 flex-1 rounded-[9px] text-[12.5px] transition ${mode === m ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
            {mode === m && <motion.div layoutId="seg-openai-auth" className="absolute inset-0 rounded-[9px] bg-card-hi shadow" transition={spring} />}
            <span className="relative">{m === 'chatgpt' ? 'My ChatGPT account' : 'API key'}</span>
          </button>
        ))}
      </div>
      {mode === 'chatgpt' ? (
        <>
          <div className="mb-2 text-[11.5px] leading-relaxed text-ink-3">
            Uses your ChatGPT plan through OpenAI's Codex app on this computer, the same way the Codex app and IDE extension do. No per-token bill, it counts against your plan's usage limits.
          </div>
          {!settings.mock && <ChatgptRow status={settings.chatgpt} />}
        </>
      ) : (
        <KeyRow
          label="OpenAI API key"
          saved={settings.hasOpenaiKey}
          models={settings.openaiModels?.length ?? 0}
          placeholder="sk-…"
          onSave={(k) => set({ openaiKey: k })}
          hint={<>Billed per token on your OpenAI account. Make one at <span className="whitespace-nowrap">platform.openai.com/api-keys</span>.</>}
        />
      )}
    </div>
  );
}

function ChatgptRow({ status }: { status: ChatgptStatus | undefined }) {
  const s = status;
  const btn = 'flex shrink-0 items-center gap-1.5 rounded-[9px] px-3 py-1.5 text-[12px] font-semibold';
  if (!s?.found) {
    return (
      <div className="rounded-xl border border-line bg-[#1a1a1a] px-3 py-2.5">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 text-[12.5px]">
            <span className="h-2 w-2 rounded-full bg-st-waiting" /> Codex isn't installed yet
          </div>
          <div className="flex gap-1.5">
            <button onClick={() => send({ t: 'codex.check' })} title="Look again" className="rounded-[9px] p-1.5 text-ink-3 hover:bg-white/[0.06] hover:text-ink-2">
              <RefreshCw size={13} />
            </button>
            <button onClick={() => send({ t: 'codex.install' })} className={`${btn} bg-accent text-white hover:bg-accent-hi`}>
              <Download size={13} /> Install
            </button>
          </div>
        </div>
        <div className="mt-1.5 text-[11.5px] leading-snug text-ink-3">Opens a window that installs it with npm, it takes a minute. Then press the refresh button.</div>
      </div>
    );
  }
  if (!s.signedIn) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-xl border border-line bg-[#1a1a1a] px-3 py-2.5">
        <div className="flex items-center gap-2 text-[12.5px]">
          <span className="h-2 w-2 rounded-full bg-st-waiting" /> Not signed in yet
        </div>
        <button onClick={() => send({ t: 'codex.login' })} className={`${btn} bg-accent text-white hover:bg-accent-hi`}>
          <LogIn size={13} /> Sign in with ChatGPT
        </button>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-line bg-[#1a1a1a] px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2 text-[12.5px]">
          <span className="h-2 w-2 shrink-0 rounded-full bg-st-idle" />
          <span className="truncate">{s.email ?? 'Signed in'}</span>
          {s.plan && <span className="shrink-0 rounded-md bg-card-hi px-1.5 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-2">{s.plan}</span>}
        </div>
        <button onClick={() => send({ t: 'codex.check' })} title="Refresh" className="rounded-[9px] p-1.5 text-ink-3 hover:bg-white/[0.06] hover:text-ink-2">
          <RefreshCw size={13} />
        </button>
      </div>
      {s.usage && (s.usage.primary || s.usage.secondary) && (
        <div className="mt-2.5 space-y-2">
          {s.usage.primary && <UsageBar label={windowName(s.usage.primary.windowMins, '5-hour limit')} w={s.usage.primary} />}
          {s.usage.secondary && <UsageBar label={windowName(s.usage.secondary.windowMins, 'Weekly limit')} w={s.usage.secondary} />}
        </div>
      )}
    </div>
  );
}

function windowName(mins: number | null, fallback: string) {
  if (!mins) return fallback;
  if (mins >= 10_080 - 60) return 'Weekly limit';
  if (mins >= 1440) return `${Math.round(mins / 1440)}-day limit`;
  return `${Math.round(mins / 60)}-hour limit`;
}

function UsageBar({ label, w }: { label: string; w: { usedPercent: number; resetsAt: number | null } }) {
  const pct = Math.min(100, Math.max(0, w.usedPercent));
  const color = pct >= 90 ? 'var(--color-st-error)' : pct >= 75 ? 'var(--color-st-waiting)' : 'var(--color-st-idle)';
  return (
    <div>
      <div className="mb-1 flex justify-between text-[11px] text-ink-3">
        <span>{label}</span>
        <span className="font-mono">
          {Math.round(pct)}% used{w.resetsAt ? ` · resets ${resetIn(w.resetsAt)}` : ''}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-card-hi">
        <motion.div className="h-full rounded-full" style={{ background: color }} initial={{ width: 0 }} animate={{ width: `${pct}%` }} transition={spring} />
      </div>
    </div>
  );
}

function resetIn(at: number) {
  const ms = (at < 1e12 ? at * 1000 : at) - Date.now();
  if (ms <= 0) return 'now';
  const h = Math.floor(ms / 3_600_000);
  if (h >= 24) return `in ${Math.round(h / 24)}d`;
  if (h >= 1) return `in ${h}h`;
  return `in ${Math.max(1, Math.round(ms / 60_000))}m`;
}
