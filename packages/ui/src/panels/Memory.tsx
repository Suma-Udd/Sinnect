// Memory UI: the "Sinnect learned N things" card, the memory browser, and the settings block.

import { useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import NumberFlow from '@number-flow/react';
import { Brain, Check, ChevronRight, FolderOpen, RefreshCw, Search, Trash2, X } from 'lucide-react';
import type { MemoryNote } from '@engine/protocol';
import { useApp } from '../store';
import { inTauri, send } from '../engine';
import { spring } from '../lib';
import { Num, Sheet, Switch } from './Toolbar';

const KIND: Record<string, { label: string; color: string }> = {
  rule: { label: 'Rule', color: '#ff8a6e' },
  worked: { label: 'Worked', color: '#a3e635' },
  broke: { label: 'Broke', color: '#f87171' },
  skill: { label: 'Skill', color: '#2dd4bf' },
};
const kindOf = (n: MemoryNote) => KIND[n.kind === 'skill' ? 'skill' : (n.type ?? 'rule')];

function Chip({ n }: { n: MemoryNote }) {
  const k = kindOf(n);
  return (
    <span className="w-[52px] shrink-0 rounded-md py-[1px] text-center font-mono text-[10px] font-medium uppercase tracking-wide" style={{ color: k.color, background: `color-mix(in srgb, ${k.color} 13%, transparent)` }}>
      {k.label}
    </span>
  );
}

export async function pickFolder(current?: string | null): Promise<string | null> {
  if (!inTauri()) return null;
  const { open } = await import('@tauri-apps/plugin-dialog');
  const dir = await open({ directory: true, multiple: false, defaultPath: current || undefined });
  return typeof dir === 'string' ? dir : null;
}

/** Slides in under the toolbar when sessions save new notes. */
export function LearnedCard() {
  const ids = useApp((s) => s.learned);
  const memory = useApp((s) => s.memory);
  const sessionsOpen = useApp((s) => !!s.expanded || !!s.setup);
  const notes = useMemo(() => ids.map((id) => memory.find((n) => n.id === id)).filter((n): n is MemoryNote => !!n), [ids, memory]);
  const show = notes.length > 0 && !sessionsOpen;
  const dismiss = (list: string[]) => useApp.getState().set({ learned: useApp.getState().learned.filter((id) => !list.includes(id)) });
  const keep = (list: string[]) => (send({ t: 'memory.keep', ids: list }), dismiss(list));
  const drop = (list: string[]) => (send({ t: 'memory.delete', ids: list }), dismiss(list));
  const visible = notes.slice(-4).reverse();

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="learned"
          initial={{ opacity: 0, x: 40, scale: 0.96 }}
          animate={{ opacity: 1, x: 0, scale: 1 }}
          exit={{ opacity: 0, x: 30, scale: 0.97 }}
          transition={spring}
          className="fixed right-4 top-[64px] z-30 w-[360px] max-w-[calc(100vw-32px)] overflow-hidden rounded-[20px] border border-line bg-panel/95 shadow-[0_24px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl"
        >
          <div className="flex items-center gap-3 px-4 pb-2 pt-3.5">
            <motion.div
              key={notes.length}
              initial={{ scale: 0.6, rotate: -12 }}
              animate={{ scale: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 500, damping: 18 }}
              className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-accent-soft text-accent"
            >
              <Brain size={17} />
            </motion.div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-1 text-[14px] font-semibold">
                Sinnect learned <NumberFlow value={notes.length} className="font-mono tabular-nums text-accent-hi" /> thing{notes.length === 1 ? '' : 's'}
              </div>
              <div className="text-[11.5px] text-ink-3">Future sessions here will know this. Keep it or toss it.</div>
            </div>
            <button onClick={() => dismiss(ids)} title="Hide (notes stay saved)" className="rounded-lg p-1.5 text-ink-3 transition hover:bg-white/[0.06] hover:text-ink-2">
              <X size={15} />
            </button>
          </div>
          <div className="px-2">
            <AnimatePresence initial={false}>
              {visible.map((n, i) => (
                <motion.div
                  key={n.id}
                  layout
                  initial={{ opacity: 0, y: -10, height: 0 }}
                  animate={{ opacity: 1, y: 0, height: 'auto', transition: { delay: i * 0.05, ...spring } }}
                  exit={{ opacity: 0, x: 40, height: 0, transition: { duration: 0.22 } }}
                  className="group overflow-hidden"
                >
                  <div className="flex items-start gap-2.5 rounded-[14px] px-2.5 py-2 transition hover:bg-white/[0.035]">
                    <div className="mt-[1px]">
                      <Chip n={n} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[12.5px] font-medium text-ink">{n.title}</div>
                      <div className="line-clamp-2 text-[11.5px] leading-[17px] text-ink-3">{n.kind === 'skill' ? n.description : n.body}</div>
                    </div>
                    <div className="flex shrink-0 gap-0.5 opacity-60 transition group-hover:opacity-100">
                      <button onClick={() => keep([n.id])} title="Keep" className="rounded-lg p-1.5 text-ink-3 transition hover:bg-st-idle/15 hover:text-st-idle">
                        <Check size={14} />
                      </button>
                      <button onClick={() => drop([n.id])} title="Delete" className="rounded-lg p-1.5 text-ink-3 transition hover:bg-st-error/15 hover:text-st-error">
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </div>
                </motion.div>
              ))}
            </AnimatePresence>
            {notes.length > visible.length && <div className="px-2.5 pb-1 text-[11.5px] text-ink-3">and {notes.length - visible.length} more</div>}
          </div>
          <div className="mt-1 flex gap-2 border-t border-line/70 px-3 py-2.5">
            <motion.button whileTap={{ scale: 0.97 }} onClick={() => keep(ids)} className="h-8 flex-1 rounded-[10px] bg-accent text-[12.5px] font-semibold text-white transition hover:bg-accent-hi">
              Keep all
            </motion.button>
            <button onClick={() => useApp.getState().set({ memoryOpen: true })} className="flex h-8 items-center gap-1 rounded-[10px] border border-line px-3 text-[12.5px] text-ink-2 transition hover:border-line-hi hover:text-ink">
              Review <ChevronRight size={13} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

/** Browse, search and delete everything sessions learned. */
export function MemorySheet() {
  const open = useApp((s) => s.memoryOpen);
  const memory = useApp((s) => s.memory);
  const settings = useApp((s) => s.settings);
  const [tab, setTab] = useState<'lesson' | 'skill'>('lesson');
  const [q, setQ] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);
  const close = () => useApp.getState().set({ memoryOpen: false });
  const lessons = memory.filter((n) => n.kind === 'lesson');
  const skills = memory.filter((n) => n.kind === 'skill');
  const list = (tab === 'lesson' ? lessons : skills).filter((n) => !q.trim() || `${n.title} ${n.body} ${n.project ?? ''} ${n.tags.join(' ')}`.toLowerCase().includes(q.trim().toLowerCase()));

  return (
    <Sheet open={open} onClose={close} title="Memory">
      <div className="mb-3 flex items-center gap-2 rounded-xl border border-line bg-field px-3 py-2 text-[11.5px] text-ink-3">
        <FolderOpen size={13} className="shrink-0" />
        <span className="min-w-0 flex-1 truncate font-mono" title={settings?.memoryPath}>
          {settings?.memoryPath}
        </span>
        <button onClick={() => send({ t: 'memory.list' })} title="Re-read the folder" className="rounded-md p-1 transition hover:bg-white/[0.06] hover:text-ink-2">
          <RefreshCw size={12} />
        </button>
      </div>
      <div className="mb-3 flex gap-1 rounded-[12px] border border-line bg-field p-1">
        {(['lesson', 'skill'] as const).map((k) => (
          <button key={k} onClick={() => setTab(k)} className={`relative h-8 flex-1 rounded-[9px] text-[12.5px] transition ${tab === k ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
            {tab === k && <motion.span layoutId="mem-tab" transition={spring} className="absolute inset-0 rounded-[9px] bg-card-hi shadow" />}
            <span className="relative">
              {k === 'lesson' ? 'Lessons' : 'Skills'} <span className="font-mono text-ink-3">{k === 'lesson' ? lessons.length : skills.length}</span>
            </span>
          </button>
        ))}
      </div>
      <div className="relative mb-2">
        <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
        <input className="field !pl-8" placeholder="Search notes" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <div className="-mx-1 max-h-[52vh] overflow-y-auto px-1">
        {list.length === 0 && (
          <div className="py-8 text-center text-[12.5px] leading-relaxed text-ink-3">
            {memory.length === 0 ? 'Nothing yet. When a session that did real work stops, it writes down what it learned here.' : 'No matches.'}
          </div>
        )}
        <AnimatePresence initial={false}>
          {list.map((n) => (
            <motion.div key={n.id} layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, height: 0 }} className="group overflow-hidden">
              <div className="rounded-xl px-2.5 py-2 transition hover:bg-white/[0.035]">
                <div className="flex items-center gap-2">
                  <button onClick={() => setOpenId(openId === n.id ? null : n.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <motion.span animate={{ rotate: openId === n.id ? 90 : 0 }} className="text-ink-3">
                      <ChevronRight size={13} />
                    </motion.span>
                    <Chip n={n} />
                    <span className="truncate text-[12.5px]">{n.title}</span>
                    {!n.reviewed && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="New, not reviewed yet" />}
                  </button>
                  <span className="shrink-0 font-mono text-[10.5px] text-ink-3">{n.project ?? 'everywhere'}</span>
                  <button onClick={() => send({ t: 'memory.delete', ids: [n.id] })} title="Delete" className="rounded-md p-1 text-ink-3 opacity-0 transition hover:text-st-error group-hover:opacity-100">
                    <Trash2 size={13} />
                  </button>
                </div>
                <AnimatePresence initial={false}>
                  {openId === n.id && (
                    <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden">
                      <div className="select-text whitespace-pre-wrap pl-6 pt-1.5 text-[12px] leading-relaxed text-ink-2">
                        {n.kind === 'skill' && n.description && <div className="mb-1 text-ink-3">{n.description}</div>}
                        {n.body}
                      </div>
                      <div className="pl-6 pt-1 text-[10.5px] text-ink-3">
                        {n.source ? `by ${n.source} · ` : ''}
                        {new Date(n.createdAt).toLocaleDateString()} · {n.id}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
      <div className="mt-3 text-[11.5px] leading-relaxed text-ink-3">Plain markdown files. Edit them in any editor or point the folder at your Obsidian vault in Settings.</div>
    </Sheet>
  );
}

/** The memory part of the settings sheet. */
export function MemorySettings() {
  const settings = useApp((s) => s.settings);
  const [dir, setDir] = useState<string | null>(null);
  if (!settings) return null;
  const set = (patch: Record<string, unknown>) => send({ t: 'settings.set', patch });
  const browse = async () => {
    const d = await pickFolder(settings.memoryDir);
    if (d) set({ memoryDir: d });
  };
  return (
    <div className="mb-4 rounded-xl border border-line bg-field px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-[12.5px]">
            <Brain size={13} className="text-accent" /> Memory
          </div>
          <div className="text-[11.5px] leading-snug text-ink-3">Sessions save short lessons and skills, and new sessions load the ones that matter</div>
        </div>
        <Switch on={settings.memoryEnabled !== false} onChange={(v) => set({ memoryEnabled: v })} />
      </div>
      {settings.memoryEnabled !== false && (
        <div className="mt-3 border-t border-line/70 pt-3">
          <div className="mb-1.5 text-[12px] text-ink-2">Memory folder</div>
          <div className="flex gap-2">
            <input
              className="field font-mono !text-[11.5px]"
              placeholder={settings.memoryPath}
              value={dir ?? settings.memoryDir ?? ''}
              onChange={(e) => setDir(e.target.value)}
              onBlur={() => dir !== null && (set({ memoryDir: dir.trim() || null }), setDir(null))}
            />
            {inTauri() && (
              <button onClick={browse} className="shrink-0 rounded-[10px] border border-line px-3 text-[12px] text-ink-2 transition hover:border-line-hi hover:text-ink">
                Browse
              </button>
            )}
          </div>
          <div className="mb-3 mt-1.5 text-[11.5px] leading-relaxed text-ink-3">
            Tip: pick a folder inside your Obsidian vault (like <span className="font-mono">Vault/Sinnect</span>) to see and edit what your agents learned.
            {settings.memoryDir && (
              <button onClick={() => set({ memoryDir: null })} className="ml-1 underline-offset-2 hover:text-ink-2 hover:underline">
                Use the default folder
              </button>
            )}
          </div>
          <div className="mb-2.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <div className="text-[12.5px] text-ink-2">Learn when a session stops</div>
              <div className="text-[11.5px] leading-snug text-ink-3">One short extra turn, only if it did real work</div>
            </div>
            <Switch on={settings.memoryReflect !== false} onChange={(v) => set({ memoryReflect: v })} />
          </div>
          <Num label="Notes loaded per new session" value={settings.memoryMaxNotes ?? 6} onChange={(v) => set({ memoryMaxNotes: v })} step={1} />
          <button onClick={() => useApp.getState().set({ memoryOpen: true, settingsOpen: false })} className="text-[12px] text-accent-hi underline-offset-2 hover:underline">
            Browse what they learned ({useApp.getState().memory.length})
          </button>
        </div>
      )}
    </div>
  );
}
