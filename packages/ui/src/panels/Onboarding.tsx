// First-run setup guide. Five short animated steps: what Sinnect is, signing in,
// memory (with the optional Obsidian vault), helpers, and a few shortcuts.
// Nothing here is required: every step can be skipped and changed later in Settings.

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Aperture, ArrowLeft, ArrowRight, Brain, Check, FolderOpen, KeyRound, LogIn, Sparkle, Vault, Workflow, X } from 'lucide-react';
import { useApp } from '../store';
import { inTauri, send } from '../engine';
import { spring } from '../lib';
import { pickFolder } from './Memory';
import { openSetup, viewCenter } from '../actions';
import type { useReactFlow } from '@xyflow/react';

const EASE = [0.22, 1, 0.36, 1] as const;
const STEPS = ['welcome', 'signin', 'memory', 'helpers', 'ready'] as const;
type Step = (typeof STEPS)[number];

/** Opens the guide again (command palette). */
export const openGuide = () => useApp.getState().set({ guideOpen: true, settingsOpen: false, paletteOpen: false });

export function Onboarding({ rf }: { rf: ReturnType<typeof useReactFlow> }) {
  const settings = useApp((s) => s.settings);
  const open = useApp((s) => s.guideOpen);
  const [i, setI] = useState(0);
  const [dir, setDir] = useState(1);

  // First run: show after the opening animation.
  useEffect(() => {
    if (!settings || settings.onboarded) return;
    const t = setTimeout(() => useApp.getState().set({ guideOpen: true }), 2500);
    return () => clearTimeout(t);
    // Only when the settings first arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!settings]);

  useEffect(() => {
    if (open) setI(0);
  }, [open]);

  if (!settings) return null;
  const step: Step = STEPS[i];
  const finish = () => {
    useApp.getState().set({ guideOpen: false });
    if (!settings.onboarded) send({ t: 'settings.set', patch: { onboarded: true } });
  };
  const go = (d: number) => {
    const n = i + d;
    if (n < 0) return;
    if (n >= STEPS.length) return finish();
    setDir(d);
    setI(n);
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="guide"
          className="fixed inset-0 z-[90] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0, transition: { duration: 0.25 } }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') finish();
            if (e.key === 'ArrowRight') go(1);
            if (e.key === 'ArrowLeft') go(-1);
          }}
          tabIndex={-1}
          ref={(el) => el?.focus()}
        >
          <div className="absolute inset-0 bg-black/55 backdrop-blur-[3px]" onClick={finish} />
          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 12, scale: 0.98 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="relative w-[620px] max-w-full overflow-hidden rounded-[26px] border border-line bg-panel shadow-[0_40px_120px_rgba(0,0,0,0.6)]"
          >
            {/* progress */}
            <div className="flex items-center gap-1.5 px-6 pt-5">
              {STEPS.map((s, k) => (
                <button key={s} onClick={() => (setDir(k > i ? 1 : -1), setI(k))} className="h-1.5 flex-1 overflow-hidden rounded-full bg-card-hi" aria-label={`Step ${k + 1}`}>
                  <motion.div className="h-full rounded-full bg-accent" initial={false} animate={{ width: k <= i ? '100%' : '0%' }} transition={{ duration: 0.45, ease: EASE }} />
                </button>
              ))}
              <button onClick={finish} title="Skip the guide" className="ml-2 flex items-center gap-1 rounded-lg px-2 py-1 text-[12px] text-ink-3 transition hover:bg-white/[0.05] hover:text-ink-2">
                Skip <X size={13} />
              </button>
            </div>

            <div className="relative h-[412px]">
              <AnimatePresence mode="popLayout" custom={dir} initial={false}>
                <motion.div
                  key={step}
                  custom={dir}
                  variants={{
                    in: (d: number) => ({ opacity: 0, x: d * 60, filter: 'blur(6px)' }),
                    show: { opacity: 1, x: 0, filter: 'blur(0px)' },
                    out: (d: number) => ({ opacity: 0, x: d * -60, filter: 'blur(6px)' }),
                  }}
                  initial="in"
                  animate="show"
                  exit="out"
                  transition={{ duration: 0.42, ease: EASE }}
                  className="absolute inset-0 flex flex-col px-8 pb-6 pt-5"
                >
                  {step === 'welcome' && <Welcome />}
                  {step === 'signin' && <SignIn />}
                  {step === 'memory' && <MemoryStep />}
                  {step === 'helpers' && <HelpersStep />}
                  {step === 'ready' && <Ready />}
                </motion.div>
              </AnimatePresence>
            </div>

            <div className="flex items-center gap-2 border-t border-line/70 px-6 py-4">
              <div className="font-mono text-[11px] text-ink-3">
                {i + 1} / {STEPS.length}
              </div>
              <div className="ml-auto flex gap-2">
                {i > 0 && (
                  <button onClick={() => go(-1)} className="flex h-9 items-center gap-1.5 rounded-[11px] border border-line px-3.5 text-[13px] text-ink-2 transition hover:border-line-hi hover:text-ink">
                    <ArrowLeft size={14} /> Back
                  </button>
                )}
                {step === 'ready' ? (
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => {
                      finish();
                      setTimeout(() => openSetup(viewCenter(rf)), 250);
                    }}
                    className="flex h-9 items-center gap-1.5 rounded-[11px] bg-accent px-4 text-[13px] font-semibold text-white shadow-[0_8px_24px_rgba(255,107,74,0.3)] hover:bg-accent-hi"
                  >
                    Start my first session <ArrowRight size={14} />
                  </motion.button>
                ) : (
                  <motion.button
                    whileHover={{ scale: 1.02 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={() => go(1)}
                    className="flex h-9 items-center gap-1.5 rounded-[11px] bg-accent px-4 text-[13px] font-semibold text-white hover:bg-accent-hi"
                  >
                    {i === 0 ? "Let's go" : 'Next'} <ArrowRight size={14} />
                  </motion.button>
                )}
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

// ---------- pieces ----------

function Stage({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="relative mb-4 h-[168px] shrink-0 overflow-hidden rounded-[18px] border border-line bg-canvas"
      style={{ backgroundImage: 'radial-gradient(#2c2c2f 1px, transparent 1px)', backgroundSize: '18px 18px' }}
    >
      {children}
    </div>
  );
}

function Title({ kicker, title, children }: { kicker?: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div>
      {kicker}
      <div className="text-[20px] font-semibold tracking-tight">{title}</div>
      <div className="mt-1.5 text-[13px] leading-relaxed text-ink-2">{children}</div>
    </div>
  );
}

function MiniCard({ x, y, w = 92, label, color = '#2dd4bf', delay = 0, from }: { x: number; y: number; w?: number; label: string; color?: string; delay?: number; from?: { x: number; y: number } }) {
  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.6, x: from?.x ?? 0, y: from?.y ?? 10 }}
      animate={{ opacity: 1, scale: 1, x: 0, y: 0 }}
      transition={{ type: 'spring', stiffness: 260, damping: 22, delay }}
      className="absolute flex items-center gap-2 rounded-[12px] border border-line bg-card px-2.5 py-2 shadow-lg"
      style={{ left: x, top: y, width: w }}
    >
      <span className="relative flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full" style={{ background: `color-mix(in srgb, ${color} 22%, transparent)` }}>
        <span className="h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      </span>
      <span className="truncate text-[11px] font-medium">{label}</span>
    </motion.div>
  );
}

function Wire({ d, delay = 0, color = '#ff6b4a', dashed = false }: { d: string; delay?: number; color?: string; dashed?: boolean }) {
  return (
    <>
      <motion.path d={d} fill="none" stroke={color} strokeWidth={2} strokeDasharray={dashed ? '5 5' : undefined} strokeOpacity={0.8} initial={{ pathLength: 0 }} animate={{ pathLength: 1 }} transition={{ delay, duration: 0.6, ease: 'easeInOut' }} />
      <circle r={3.5} fill="#ffc2b3" opacity={0} style={{ filter: 'drop-shadow(0 0 5px #ff6b4a)' }}>
        <animateMotion dur="2.2s" begin={`${delay + 0.7}s`} repeatCount="indefinite" path={d} />
        <set attributeName="opacity" to="1" begin={`${delay + 0.7}s`} />
      </circle>
    </>
  );
}

function Welcome() {
  return (
    <>
      <Stage>
        <svg className="absolute inset-0 h-full w-full overflow-visible">
          <Wire d="M 168 66 C 220 66 220 110 268 110" delay={0.5} />
          <Wire d="M 360 110 C 410 110 400 66 452 66" delay={0.8} />
          <Wire d="M 360 120 C 410 120 400 140 452 140" delay={1.0} />
        </svg>
        <MiniCard x={76} y={48} label="Lead" color="#ff8a6e" />
        <MiniCard x={268} y={92} label="API" delay={0.15} />
        <MiniCard x={452} y={48} label="Checkout UI" w={104} delay={0.3} />
        <MiniCard x={452} y={122} label="Tests" color="#a3e635" delay={0.45} />
      </Stage>
      <Title title="Welcome to Sinnect">
        One big canvas for your AI sessions. Start Claude, Gemini or OpenAI sessions, watch them work live, and drag a wire between two so they can share what they're doing and never edit the same file at once.
      </Title>
    </>
  );
}

function SignIn() {
  const settings = useApp((s) => s.settings)!;
  const signed = settings.mock || (settings.authMode === 'local' ? settings.signedIn : settings.hasApiKey);
  return (
    <>
      <Stage>
        <div className="absolute inset-0 flex items-center justify-center gap-4">
          {[
            { label: 'Claude', ok: settings.mock || settings.signedIn || settings.hasApiKey, icon: <LogIn size={16} /> },
            { label: 'Gemini', ok: settings.mock || settings.hasGeminiKey, icon: <Sparkle size={16} />, optional: true },
            { label: 'OpenAI', ok: settings.mock || settings.hasOpenaiKey, icon: <Aperture size={16} />, optional: true },
          ].map((p, k) => (
            <motion.div
              key={p.label}
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 + k * 0.12, ...spring }}
              className="flex w-[150px] flex-col items-center rounded-[16px] border border-line bg-card px-4 py-4"
            >
              <div className={`mb-2 flex h-9 w-9 items-center justify-center rounded-[11px] ${p.ok ? 'bg-st-idle/15 text-st-idle' : 'bg-card-hi text-ink-2'}`}>{p.ok ? <Check size={17} /> : p.icon}</div>
              <div className="text-[13px] font-medium">{p.label}</div>
              <div className={`text-[11.5px] ${p.ok ? 'text-st-idle' : 'text-ink-3'}`}>{p.ok ? (settings.mock ? 'Demo mode' : 'Ready') : p.optional ? 'Optional' : 'Not signed in'}</div>
            </motion.div>
          ))}
        </div>
      </Stage>
      <Title title={signed ? "You're signed in" : 'Sign in once'}>
        {signed
          ? 'Sessions can run right away. You can switch between your Claude account and an API key, or add a Gemini or OpenAI key, any time in Settings.'
          : 'Sessions run on your Claude account through the Claude Code login on this computer, or on an API key. A free Gemini key or an OpenAI key works too.'}
      </Title>
      {!signed && (
        <div className="mt-4 flex gap-2">
          <button onClick={() => send({ t: 'auth.login' })} className="flex h-9 items-center gap-2 rounded-[11px] bg-card-hi px-3.5 text-[12.5px] font-medium text-ink transition hover:bg-line">
            <LogIn size={14} /> Sign in with Claude
          </button>
          <button
            onClick={() => (send({ t: 'settings.set', patch: { authMode: 'apiKey' } }), useApp.getState().set({ settingsOpen: true, guideOpen: false }))}
            className="flex h-9 items-center gap-2 rounded-[11px] border border-line px-3.5 text-[12.5px] text-ink-2 transition hover:border-line-hi hover:text-ink"
          >
            <KeyRound size={14} /> Use an API key
          </button>
        </div>
      )}
    </>
  );
}

const NOTES = [
  { chip: 'RULE', color: '#ff8a6e', text: 'Run npm ci, never npm install' },
  { chip: 'BROKE', color: '#f87171', text: 'Port 5173 is taken, use 5180' },
  { chip: 'SKILL', color: '#2dd4bf', text: 'Release checklist' },
];

function MemoryStep() {
  const settings = useApp((s) => s.settings)!;
  const [typing, setTyping] = useState<string | null>(null);
  const custom = !!settings.memoryDir;
  const browse = async () => {
    const d = await pickFolder(settings.memoryDir);
    if (d) send({ t: 'settings.set', patch: { memoryDir: d, memoryEnabled: true } });
  };
  return (
    <>
      <Stage>
        <MiniCard x={24} y={72} label="API" />
        {NOTES.map((n, k) => (
          <motion.div
            key={n.text}
            className="absolute flex items-center gap-1.5 rounded-[9px] border border-line bg-panel px-2 py-1 shadow-lg"
            style={{ left: 104, top: 76 }}
            initial={{ opacity: 0, x: 0, y: 0, scale: 0.7 }}
            animate={{ opacity: [0, 1, 1, 0], x: [0, 70, 150, 300], y: [0, -40 + k * 40, -40 + k * 40, 0], scale: [0.6, 1, 1, 0.35] }}
            transition={{ duration: 3.2, delay: 0.4 + k * 0.55, repeat: Infinity, repeatDelay: 1.2, times: [0, 0.25, 0.75, 1], ease: 'easeInOut' }}
          >
            <span className="rounded-[4px] px-1 font-mono text-[8.5px] font-semibold" style={{ color: n.color, background: `color-mix(in srgb, ${n.color} 15%, transparent)` }}>
              {n.chip}
            </span>
            <span className="whitespace-nowrap text-[10.5px] text-ink-2">{n.text}</span>
          </motion.div>
        ))}
        <motion.div
          initial={{ opacity: 0, scale: 0.8 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.2, ...spring }}
          className="absolute flex flex-col items-center"
          style={{ left: 470, top: 50 }}
        >
          <motion.div
            animate={{ scale: [1, 1.08, 1] }}
            transition={{ duration: 3.2, delay: 1.6, repeat: Infinity, repeatDelay: 1.2 }}
            className="flex h-[62px] w-[62px] items-center justify-center rounded-[18px] border border-accent/50 bg-accent-soft text-accent"
          >
            {custom ? <Vault size={26} /> : <Brain size={26} />}
          </motion.div>
          <div className="mt-1.5 text-[11px] font-medium text-ink-2">{custom ? 'Your vault' : 'Memory'}</div>
        </motion.div>
      </Stage>
      <Title
        kicker={
          <div className="mb-1 inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-accent-hi">
            <Brain size={11} /> Sessions learn
          </div>
        }
        title="It remembers what worked"
      >
        When a session finishes real work it writes a few short notes: repo rules, what broke, reusable skills. New sessions only load the ones that matter, so it stays cheap. We recommend pointing it at your Obsidian vault so you can read and edit everything your agents learned.
      </Title>
      <div className="mt-3.5 flex items-center gap-2">
        {inTauri() ? (
          <button onClick={browse} className="flex h-9 shrink-0 items-center gap-2 rounded-[11px] bg-card-hi px-3.5 text-[12.5px] font-medium text-ink transition hover:bg-line">
            <FolderOpen size={14} /> {custom ? 'Change folder' : 'Pick my Obsidian vault'}
          </button>
        ) : (
          <input
            className="field font-mono !text-[11.5px]"
            placeholder="Path to your Obsidian vault (optional)"
            value={typing ?? settings.memoryDir ?? ''}
            onChange={(e) => setTyping(e.target.value)}
            onBlur={() => typing !== null && (send({ t: 'settings.set', patch: { memoryDir: typing.trim() || null } }), setTyping(null))}
          />
        )}
        <div className="min-w-0 truncate text-[11.5px] text-ink-3" title={settings.memoryPath}>
          {custom ? (
            <span className="text-st-idle">
              <Check size={12} className="mr-1 inline" />
              Notes go to <span className="font-mono">{settings.memoryPath}</span>
            </span>
          ) : (
            'Optional. Without it, notes stay in Sinnect.'
          )}
        </div>
      </div>
    </>
  );
}

function HelpersStep() {
  const settings = useApp((s) => s.settings)!;
  const cap = settings.workerSpendCapUsd ?? 2;
  const helpers = [
    { label: 'Search', model: 'Haiku', y: 22 },
    { label: 'Tests', model: 'Haiku', y: 74 },
    { label: 'Code', model: 'Sonnet', y: 126 },
  ];
  return (
    <>
      <Stage>
        <svg className="absolute inset-0 h-full w-full overflow-visible">
          {helpers.map((h, k) => (
            <Wire key={h.label} d={`M 210 89 C 270 89 280 ${h.y + 18} 340 ${h.y + 18}`} delay={0.35 + k * 0.15} dashed />
          ))}
        </svg>
        <MiniCard x={100} y={70} w={110} label="Lead · Opus" color="#ff8a6e" />
        {helpers.map((h, k) => (
          <MiniCard key={h.label} x={340} y={h.y} w={150} label={`${h.label} · ${h.model}`} delay={0.3 + k * 0.15} from={{ x: -160, y: 70 - h.y }} />
        ))}
      </Stage>
      <Title
        kicker={
          <div className="mb-1 inline-flex items-center gap-1 rounded-full bg-accent-soft px-2 py-0.5 text-[10.5px] font-semibold uppercase tracking-wide text-accent-hi">
            <Workflow size={11} /> Helpers
          </div>
        }
        title="Big jobs split themselves up"
      >
        A session can send side jobs to helpers on cheaper models: Haiku for searching and tests, Sonnet for code. Each one reports back in a few lines and fades away. Max {settings.maxWorkersPerBoss ?? 4} per session, and they stop at a spend cap.
      </Title>
      <div className="mt-3.5 flex flex-wrap items-center gap-2">
        <span className="text-[12px] text-ink-3">Helper spend cap</span>
        {[1, 2, 5, 0].map((v) => (
          <button
            key={v}
            onClick={() => send({ t: 'settings.set', patch: { workerSpendCapUsd: v } })}
            className={`relative h-8 rounded-[10px] border px-3 font-mono text-[12px] transition ${cap === v ? 'border-accent text-ink' : 'border-line text-ink-3 hover:text-ink-2'}`}
          >
            {cap === v && <motion.span layoutId="cap" transition={spring} className="absolute inset-0 rounded-[9px] bg-accent/20" />}
            <span className="relative">{v ? `$${v}` : 'No cap'}</span>
          </button>
        ))}
        <button
          onClick={() => send({ t: 'settings.set', patch: { askBeforeSpawn: !settings.askBeforeSpawn } })}
          className={`ml-auto flex h-8 items-center gap-1.5 rounded-[10px] border px-3 text-[12px] transition ${settings.askBeforeSpawn ? 'border-accent text-ink' : 'border-line text-ink-3 hover:text-ink-2'}`}
        >
          <span className={`flex h-3.5 w-3.5 items-center justify-center rounded-[4px] border ${settings.askBeforeSpawn ? 'border-accent bg-accent text-white' : 'border-line-hi'}`}>{settings.askBeforeSpawn && <Check size={10} />}</span>
          Ask me first
        </button>
      </div>
    </>
  );
}

function Ready() {
  const tips = [
    { keys: ['Tab'], text: 'New session' },
    { keys: ['Ctrl', 'F'], text: 'Search and commands' },
    { keys: ['Drag'], text: 'Card to card to connect' },
    { keys: ['Double click'], text: 'Open a session' },
  ];
  return (
    <>
      <Stage>
        <div className="absolute inset-0 grid grid-cols-2 gap-2.5 p-4">
          {tips.map((t, k) => (
            <motion.div
              key={t.text}
              initial={{ opacity: 0, y: 12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ delay: 0.08 + k * 0.08, ...spring }}
              className="flex items-center gap-2.5 rounded-[14px] border border-line bg-card px-3"
            >
              <div className="flex gap-1">
                {t.keys.map((key) => (
                  <kbd key={key} className="rounded-[7px] border border-line-hi bg-card-hi px-1.5 py-0.5 font-mono text-[11px] text-ink">
                    {key}
                  </kbd>
                ))}
              </div>
              <span className="text-[12px] text-ink-2">{t.text}</span>
            </motion.div>
          ))}
        </div>
      </Stage>
      <Title title="You're set">Start a session, pick a folder, and tell it what to do. You can open this guide again any time from Ctrl+F.</Title>
    </>
  );
}
