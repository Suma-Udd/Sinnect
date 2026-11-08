import { motion } from 'motion/react';
import { Aperture, Asterisk, RefreshCw, Sparkle } from 'lucide-react';
import type { EngineSettings, PlanUsage } from '@engine/protocol';
import { compact, money } from '../lib';
import { send } from '../engine';
import { totalTokens, useApp } from '../store';

type Row = {
  key: string;
  name: string;
  icon: React.ReactNode;
  tint: string;
  plan?: string | null;
  usage?: PlanUsage | null;
  /** Shown instead of rings when there are no plan windows. */
  note?: string;
};

/** Who is connected, and what their limits look like. */
function rows(s: EngineSettings): Row[] {
  const out: Row[] = [];
  const claudePlan = s.mock || (s.authMode === 'local' && s.signedIn);
  if (claudePlan) out.push({ key: 'claude', name: 'Claude', icon: <Asterisk size={15} />, tint: '#ff8a6e', plan: s.claudeUsage?.plan, usage: s.claudeUsage?.usage ?? null, note: s.claudeUsage ? undefined : 'Checking your plan…' });
  else if (s.authMode === 'apiKey' && s.hasApiKey) out.push({ key: 'claude', name: 'Claude', icon: <Asterisk size={15} />, tint: '#ff8a6e', plan: 'API', note: 'Pay per token, no plan limits' });
  if (s.openaiAuth === 'chatgpt' && s.chatgpt?.signedIn) out.push({ key: 'chatgpt', name: 'ChatGPT', icon: <Aperture size={15} />, tint: '#5eead4', plan: s.chatgpt.plan, usage: s.chatgpt.usage, note: s.chatgpt.usage ? undefined : 'No limits reported yet' });
  else if (s.openaiAuth === 'apiKey' && s.hasOpenaiKey) out.push({ key: 'openai', name: 'OpenAI', icon: <Aperture size={15} />, tint: '#5eead4', plan: 'API', note: 'Pay per token, no plan limits' });
  if (s.hasGeminiKey) out.push({ key: 'gemini', name: 'Gemini', icon: <Sparkle size={15} />, tint: '#7dd3fc', plan: 'Key', note: 'Per-minute and per-day limits on the free key' });
  return out;
}

const item = {
  hidden: { opacity: 0, y: -8, filter: 'blur(4px)' },
  show: (i: number) => ({ opacity: 1, y: 0, filter: 'blur(0px)', transition: { delay: 0.06 + i * 0.06, type: 'spring' as const, stiffness: 420, damping: 32 } }),
};

export function UsagePanel() {
  const settings = useApp((s) => s.settings);
  const sessions = useApp((s) => s.sessions);
  if (!settings) return null;
  const list = rows(settings);
  const all = Object.values(sessions);
  const spent = all.reduce((a, x) => a + x.costUsd, 0);
  const tokens = all.reduce((a, x) => a + totalTokens(x), 0);
  return (
    <div className="w-[min(440px,calc(100vw-32px))] px-4 pt-3.5 pb-4">
      <motion.div custom={0} variants={item} initial="hidden" animate="show" className="mb-3 flex items-center justify-between">
        <div className="text-[13px] font-semibold tracking-tight">Plan limits</div>
        <button onClick={() => send({ t: 'usage.check' })} title="Refresh" className="rounded-full p-1.5 text-white/40 transition hover:bg-white/10 hover:text-white/80">
          <RefreshCw size={13} />
        </button>
      </motion.div>
      {list.length === 0 ? (
        <motion.div custom={1} variants={item} initial="hidden" animate="show" className="rounded-[20px] bg-white/[0.05] px-4 py-5 text-center text-[12.5px] text-white/50">
          Nothing connected yet. Sign in to Claude or ChatGPT in Settings.
        </motion.div>
      ) : (
        <div className="space-y-2">
          {list.map((r, i) => (
            <motion.div key={r.key} custom={i + 1} variants={item} initial="hidden" animate="show" className="flex items-center gap-3 rounded-[20px] bg-white/[0.05] px-3.5 py-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[12px]" style={{ background: `color-mix(in srgb, ${r.tint} 16%, transparent)`, color: r.tint }}>
                {r.icon}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="text-[13px] font-medium">{r.name}</span>
                  {r.plan && <span className="rounded-full bg-white/[0.08] px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-white/55">{r.plan}</span>}
                </div>
                <div className="truncate text-[11px] text-white/40">{r.note ?? resetLine(r.usage)}</div>
              </div>
              {r.usage && (
                <div className="flex shrink-0 gap-3">
                  <Ring label="5h" w={r.usage.primary} delay={0.1 + i * 0.06} />
                  <Ring label="Week" w={r.usage.secondary} delay={0.16 + i * 0.06} />
                </div>
              )}
            </motion.div>
          ))}
        </div>
      )}
      <motion.div custom={list.length + 1} variants={item} initial="hidden" animate="show" className="mt-3 flex items-center justify-between px-1 text-[11px] text-white/35">
        <span>This board</span>
        <span className="font-mono">
          {compact(tokens)} tokens · {money(spent)}
        </span>
      </motion.div>
    </div>
  );
}

/** A small ring gauge, filling up with a spring. */
function Ring({ label, w, delay }: { label: string; w: PlanUsage['primary']; delay: number }) {
  const size = 44;
  const stroke = 4;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = w ? Math.min(100, Math.max(0, w.usedPercent)) : 0;
  const color = !w ? 'rgba(255,255,255,0.2)' : pct >= 90 ? '#f87171' : pct >= 70 ? '#fbbf24' : '#a3e635';
  return (
    <div className="flex flex-col items-center" title={w?.resetsAt ? `Resets ${new Date(w.resetsAt * 1000).toLocaleString()}` : undefined}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="-rotate-90">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={stroke} />
          <motion.circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke={color}
            strokeWidth={stroke}
            strokeLinecap="round"
            strokeDasharray={c}
            initial={{ strokeDashoffset: c }}
            animate={{ strokeDashoffset: c * (1 - pct / 100) }}
            transition={{ delay, type: 'spring', stiffness: 90, damping: 18 }}
            style={{ filter: pct >= 90 ? `drop-shadow(0 0 4px ${color})` : undefined }}
          />
        </svg>
        <div className="absolute inset-0 flex items-center justify-center font-mono text-[10.5px] font-medium text-white/85">{w ? `${Math.round(pct)}%` : '–'}</div>
      </div>
      <div className="mt-1 text-[9.5px] font-medium uppercase tracking-wider text-white/40">{label}</div>
    </div>
  );
}

function resetLine(u: PlanUsage | null | undefined) {
  if (!u) return '';
  if (u.reached) return 'Limit reached';
  const parts: string[] = [];
  if (u.primary?.resetsAt) parts.push(`5h resets ${when(u.primary.resetsAt)}`);
  if (u.secondary?.resetsAt) parts.push(`week ${when(u.secondary.resetsAt)}`);
  return parts.join(' · ');
}

function when(at: number) {
  const ms = at * 1000 - Date.now();
  if (ms <= 0) return 'now';
  const h = ms / 3_600_000;
  if (h >= 24) return `in ${Math.round(h / 24)} day${Math.round(h / 24) === 1 ? '' : 's'}`;
  if (h >= 1) return `in ${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`;
  return `in ${Math.max(1, Math.round(ms / 60_000))}m`;
}
