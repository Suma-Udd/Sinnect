import { memo, useEffect, useRef, useState } from 'react';
import { Handle, Position, useStore, type NodeProps } from '@xyflow/react';
import { Cost } from '../components/Cost';
import { AnimatePresence, motion } from 'motion/react';
import NumberFlow from '@number-flow/react';
import { Eye, EyeOff, Users, FileLock2, MessageSquare, Pin, PinOff, Play, ShieldCheck, ShieldAlert, Workflow, Zap } from 'lucide-react';
import { WORKER_KIND_LABEL } from '@engine/protocol';
import type { WorkerStats } from '@engine/protocol';
import { isActive, totalTokens, useApp, type AppNode, type SessionNodeData } from '../store';
import { STATUS, modelLabel, money } from '../lib';
import { send } from '../engine';

const zoomSel = (s: { transform: [number, number, number] }) => s.transform[2];

function StatusRing({ status, size = 34 }: { status: keyof typeof STATUS; size?: number }) {
  const color = STATUS[status].color;
  const active = status === 'thinking' || status === 'working' || status === 'starting';
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <div className="absolute inset-0 rounded-full" style={{ background: `color-mix(in srgb, ${color} 16%, transparent)` }} />
      {active ? (
        <svg className="spin-slow absolute inset-0" viewBox="0 0 36 36">
          <circle cx="18" cy="18" r="15.5" fill="none" stroke={color} strokeOpacity="0.25" strokeWidth="2.5" />
          <circle cx="18" cy="18" r="15.5" fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeDasharray="30 100" />
        </svg>
      ) : (
        <svg className="absolute inset-0" viewBox="0 0 36 36">
          <circle cx="18" cy="18" r="15.5" fill="none" stroke={color} strokeWidth="2.5" strokeOpacity={status === 'stopped' ? 0.5 : 1} />
        </svg>
      )}
      <motion.div
        className="absolute rounded-full"
        style={{ inset: size * 0.33, background: color }}
        animate={status === 'waiting' ? { scale: [1, 1.35, 1] } : { scale: 1 }}
        transition={status === 'waiting' ? { repeat: Infinity, duration: 1.2 } : {}}
      />
    </div>
  );
}

/** Where a new helper card starts its fly-in: on top of its boss. */
function spawnOffset(id: string): { x: number; y: number } | null {
  const s = useApp.getState();
  const st = s.sessions[id];
  if (!st?.config.parentId || st.summary || s.dormant[id]) return null;
  // Only animate brand new helpers, not ones restored or re-rendered later.
  if (Date.now() - st.startedAt > 3000) return null;
  const me = s.nodes.find((n) => n.id === id);
  const boss = s.nodes.find((n) => n.id === st.config.parentId);
  if (!me || !boss) return null;
  return { x: (boss.position.x - me.position.x) * 0.85, y: (boss.position.y - me.position.y) * 0.85 };
}

/** Boss cards: helpers running and how much of the spend cap they used. */
function HelperStrip({ w }: { w: WorkerStats }) {
  const pct = w.capUsd > 0 ? Math.min(1, w.spentUsd / w.capUsd) : 0;
  const hot = pct > 0.8;
  return (
    <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="overflow-hidden px-4">
      <div className="mt-1 flex items-center gap-2 text-[11px]">
        <Workflow size={12} className={w.running ? 'text-accent' : 'text-ink-3'} />
        <span className="text-ink-2">
          {w.running ? (
            <>
              <NumberFlow value={w.running} className="font-mono tabular-nums" /> helper{w.running === 1 ? '' : 's'} working
            </>
          ) : (
            `${w.total} helper${w.total === 1 ? '' : 's'} done`
          )}
        </span>
        <span className={`ml-auto font-mono tabular-nums ${hot ? 'text-st-blocked' : 'text-ink-3'}`}>
          {money(w.spentUsd)}
          {w.capUsd > 0 ? ` / ${money(w.capUsd)}` : ''}
        </span>
      </div>
      {w.capUsd > 0 && (
        <div className="mt-1.5 h-[3px] overflow-hidden rounded-full bg-card-hi">
          <motion.div className="h-full rounded-full" style={{ background: hot ? 'var(--color-st-blocked)' : 'var(--color-accent)' }} animate={{ width: `${Math.max(2, pct * 100)}%` }} transition={{ type: 'spring', stiffness: 200, damping: 30 }} />
        </div>
      )}
    </motion.div>
  );
}

export const SessionNode = memo(function SessionNode({ id, data, selected }: NodeProps<AppNode & { data: SessionNodeData }>) {
  const st = useApp((s) => s.sessions[data.sessionId]);
  const dormant = useApp((s) => !!s.dormant[data.sessionId]);
  const claims = useApp((s) => s.claims.filter((c) => c.sessionId === data.sessionId).length);
  const unread = useApp((s) => s.messages.filter((m) => m.to === data.sessionId && m.from !== 'hub' && Date.now() - m.ts < 60_000).length);
  const family = useApp((s) => s.families.find((f) => f.id === st?.config.familyId));
  const expanded = useApp((s) => s.expanded === data.sessionId);
  const zoom = useStore(zoomSel);
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useApp((s) => !!s.pinned[data.sessionId]);
  // Helpers fly out of their boss card.
  const from = useRef(spawnOffset(id)).current;
  const isHelper = !!st?.config.parentId;
  const done = isHelper && !!st?.summary && !dormant;
  const [leaving, setLeaving] = useState(false);

  // Done helpers fade out after a moment unless pinned.
  useEffect(() => {
    if (!done || pinned) return;
    const t = setTimeout(() => setLeaving(true), 4500);
    return () => clearTimeout(t);
  }, [done, pinned]);
  useEffect(() => {
    if (pinned) setLeaving(false);
  }, [pinned]);

  if (!st) return null;
  const status = dormant ? 'stopped' : st.status;
  const color = STATUS[status].color;
  const active = isActive(st) && !dormant;

  const open = () => {
    const rect = ref.current?.getBoundingClientRect() ?? null;
    useApp.getState().set({ expanded: data.sessionId, expandFrom: rect });
  };

  const resume = (e: React.MouseEvent) => {
    e.stopPropagation();
    const cfg = { ...st.config, prompt: '', resumeId: st.sdkSessionId };
    useApp.setState((s) => {
      const d = { ...s.dormant };
      delete d[data.sessionId];
      return { dormant: d };
    });
    send({ t: 'session.create', id: data.sessionId, config: cfg });
  };

  // Far away: a simple glance card keeps big boards smooth and readable.
  if (zoom < 0.42) {
    return (
      <div ref={ref} onDoubleClick={open} className="flex items-center gap-4 rounded-[28px] border-2 px-6 py-5" style={{ width: 280, borderColor: color, background: '#212122' }}>
        <div className="h-10 w-10 shrink-0 rounded-full" style={{ background: color }} />
        <div className="truncate text-3xl font-semibold">{st.config.name}</div>
        <Handle id="in" type="target" position={Position.Left} />
        <Handle id="out" type="source" position={Position.Right} />
      </div>
    );
  }

  // Handles live outside the animated card: React Flow measures them once, and a card that is
  // mid fly-in (or mid scale) would leave the wires pointing at the wrong spot.
  return (
    <div className="relative" style={{ width: 280 }}>
    <motion.div
      ref={ref}
      initial={from ? { opacity: 0, scale: 0.45, x: from.x, y: from.y } : { opacity: 0, scale: 0.9, y: 8 }}
      animate={leaving ? { opacity: 0, scale: 0.82, x: -24, filter: 'blur(4px)' } : { opacity: expanded ? 0.35 : 1, scale: 1, x: 0, y: 0, filter: 'blur(0px)' }}
      transition={leaving ? { duration: 0.6, ease: [0.4, 0, 0.2, 1] } : { type: 'spring', stiffness: from ? 260 : 380, damping: from ? 24 : 28 }}
      onAnimationComplete={() => leaving && send({ t: 'session.remove', id: data.sessionId })}
      onDoubleClick={open}
      className="group relative"
      style={{ width: 280 }}
    >
      {/* breathing glow while working */}
      {active && (
        <div className="breathe pointer-events-none absolute -inset-[6px] rounded-[22px]" style={{ boxShadow: `0 0 24px 2px color-mix(in srgb, ${color} 45%, transparent)` }} />
      )}
      <div
        className="relative overflow-hidden rounded-[18px] border bg-card transition-colors duration-200"
        style={{
          borderColor: selected ? '#ff6b4a' : status === 'waiting' ? color : 'var(--color-line)',
          boxShadow: '0 10px 30px rgba(0,0,0,0.35), inset 0 1px 0 rgba(255,255,255,0.04)',
        }}
      >
        {family && <div className="absolute inset-x-0 top-0 h-[3px]" style={{ background: family.color }} />}
        <div className="flex items-center gap-3 px-4 pb-2 pt-4">
          <StatusRing status={status} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[14px] font-semibold leading-tight" title={st.config.name}>
              {isHelper ? st.config.name.replace(/^[A-Za-z]+: /, '') : st.config.name}
            </div>
            <div className="mt-0.5 flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-3">
              {isHelper && (
                <span className="shrink-0 rounded-[5px] bg-accent-soft px-1.5 font-mono text-[9.5px] font-semibold uppercase leading-[16px] tracking-wide text-accent-hi">
                  {st.config.workerKind ? WORKER_KIND_LABEL[st.config.workerKind] : 'Helper'}
                </span>
              )}
              <span style={{ color: done ? 'var(--color-st-idle)' : color }}>{dormant ? 'Saved' : done ? 'Done' : STATUS[status].label}</span>
              <span>·</span>
              <span className="truncate">{modelLabel(st.config.model)}</span>
            </div>
          </div>
          {isHelper && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                useApp.setState((s) => ({ pinned: { ...s.pinned, [data.sessionId]: !pinned } }));
              }}
              title={pinned ? 'Unpin: fade out when done' : 'Pin: keep this helper on the board'}
              className={`nodrag rounded-lg p-1.5 transition hover:bg-card-hi ${pinned ? 'text-accent' : 'text-ink-3 opacity-0 group-hover:opacity-100'}`}
            >
              {pinned ? <Pin size={13} /> : <PinOff size={13} />}
            </button>
          )}
          {!isHelper && (
            <button
              onClick={open}
              className="nodrag rounded-lg px-2 py-1 text-[11px] text-ink-2 opacity-0 transition hover:bg-card-hi hover:text-ink group-hover:opacity-100"
            >
              Open
            </button>
          )}
        </div>

        <div className="h-[38px] px-4">
          <AnimatePresence mode="popLayout" initial={false}>
            <motion.div
              key={dormant ? 'dormant' : st.activity}
              initial={{ opacity: 0, y: 8, filter: 'blur(3px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -8, filter: 'blur(3px)' }}
              transition={{ duration: 0.28 }}
              className={`line-clamp-2 text-[12.5px] leading-[19px] ${active ? 'shimmer-text' : 'text-ink-2'}`}
            >
              {dormant ? st.goal || 'Saved session, resume to keep going' : done ? st.summary : st.goal && status === 'idle' ? st.goal : st.activity}
            </motion.div>
          </AnimatePresence>
        </div>

        {st.workers && st.workers.total > 0 && <HelperStrip w={st.workers} />}

        <div className="mt-2 flex items-center gap-3 border-t border-line/70 px-4 py-2.5 text-[11.5px] text-ink-2">
          <div className="flex items-center gap-1" title="Tokens used (input + output)">
            <Zap size={12} className="text-ink-3" />
            <NumberFlow value={totalTokens(st)} format={{ notation: 'compact', maximumFractionDigits: 1 }} className="font-mono tabular-nums" />
          </div>
          <Cost usd={st.costUsd} className="font-mono tabular-nums text-ink-3" />
          <div className="ml-auto flex items-center gap-2 text-ink-3">
            {claims > 0 && (
              <span className="flex items-center gap-0.5" title={`${claims} file(s) claimed`}>
                <FileLock2 size={12} />
                {claims}
              </span>
            )}
            <AnimatePresence>
              {unread > 0 && (
                <motion.span initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} className="flex items-center gap-0.5 text-st-thinking" title="Recent messages">
                  <MessageSquare size={12} />
                  {unread}
                </motion.span>
              )}
            </AnimatePresence>
            <span title={`Awareness: ${st.config.awareness}`}>
              {st.config.awareness === 'solo' ? <EyeOff size={12} /> : st.config.awareness === 'family' ? <Users size={12} /> : <Eye size={12} />}
            </span>
            <span title={`Permissions: ${st.config.permission}`}>
              {st.config.permission === 'ask' ? <ShieldCheck size={12} /> : <ShieldAlert size={12} className={st.config.permission === 'auto' ? 'text-st-blocked' : ''} />}
            </span>
            <span className="rounded-md bg-card-hi px-1.5 py-0.5 font-mono text-[10.5px] text-ink-2" title="Priority">
              P{st.config.priority}
            </span>
          </div>
        </div>

        {dormant && (
          <button onClick={resume} className="nodrag flex w-full items-center justify-center gap-1.5 border-t border-line/70 py-2 text-[12px] font-medium text-st-idle transition hover:bg-card-hi">
            <Play size={12} /> Resume
          </button>
        )}
      </div>
    </motion.div>
      <Handle id="in" type="target" position={Position.Left} style={{ opacity: leaving ? 0 : 1, transition: 'opacity 0.4s' }} />
      <Handle id="out" type="source" position={Position.Right} style={{ opacity: leaving ? 0 : 1, transition: 'opacity 0.4s' }} />
      <span className="sr-only">{id}</span>
    </div>
  );
});
