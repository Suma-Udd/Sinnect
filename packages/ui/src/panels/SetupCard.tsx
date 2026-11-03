import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Eye, EyeOff, FolderOpen, Rocket, ShieldAlert, ShieldCheck, ShieldEllipsis, Users, X } from 'lucide-react';
import { DEFAULT_MODELS, type Awareness, type PermissionChoice, type SessionConfig } from '@engine/protocol';
import { useApp, type AppNode } from '../store';
import { inTauri, send } from '../engine';
import { spring, uid } from '../lib';

const LAST = 'sinnect.lastSetup';

function loadLast(): Partial<SessionConfig> {
  try {
    return JSON.parse(localStorage.getItem(LAST) || '{}');
  } catch {
    return {};
  }
}

export function SetupCard() {
  // Keep the value we opened with: during the exit animation the store's setup is already null.
  const live = useApp((s) => s.setup);
  const setup = useRef(live!).current;
  const families = useApp((s) => s.families);
  const settings = useApp((s) => s.settings);
  const count = useApp((s) => Object.keys(s.sessions).length);
  const last = useRef(loadLast()).current;

  const [name, setName] = useState(`Session ${count + 1}`);
  const [cwd, setCwd] = useState(last.cwd ?? '');
  const [model, setModel] = useState(last.model ?? settings?.defaultModel ?? DEFAULT_MODELS[1].id);
  const [prompt, setPrompt] = useState('');
  const [priority, setPriority] = useState(3);
  const [awareness, setAwareness] = useState<Awareness>(last.awareness ?? 'family');
  const [permission, setPermission] = useState<PermissionChoice>(last.permission ?? 'ask');
  const [familyId, setFamilyId] = useState<string | null>(setup.familyId);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    promptRef.current?.focus();
  }, []);

  const close = () => useApp.getState().set({ setup: null });

  const pickFolder = async () => {
    if (!inTauri()) return;
    const { open } = await import('@tauri-apps/plugin-dialog');
    const dir = await open({ directory: true, multiple: false, defaultPath: cwd || undefined });
    if (typeof dir === 'string') setCwd(dir);
  };

  const canStart = cwd.trim().length > 0 || settings?.mock;

  const start = () => {
    if (!canStart) return;
    const id = uid('s');
    const config: SessionConfig = {
      name: name.trim() || 'Session',
      cwd: cwd.trim() || '/demo/project',
      model,
      prompt: prompt.trim(),
      priority,
      awareness,
      permission,
      familyId,
    };
    localStorage.setItem(LAST, JSON.stringify({ cwd: config.cwd, model, awareness, permission }));
    const st = useApp.getState();
    const node: AppNode = { id, type: 'session', position: setup.position, data: { sessionId: id } };
    st.set({ nodes: [...st.nodes, node], setup: null });
    send({ t: 'session.create', id, config });
  };

  return (
    <motion.div className="fixed inset-0 z-40 flex items-center justify-center" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="absolute inset-0 bg-black/45 backdrop-blur-[2px]" onClick={close} />
      <motion.div
        initial={{ opacity: 0, scale: 0.92, y: 16 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.95, y: 8 }}
        transition={spring}
        className="relative w-[560px] max-w-[calc(100vw-32px)] rounded-[24px] border border-line bg-panel p-6 shadow-[0_30px_80px_rgba(0,0,0,0.55)]"
        onKeyDown={(e) => {
          if (e.key === 'Escape') close();
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) start();
        }}
      >
        <div className="mb-5 flex items-center justify-between">
          <div>
            <div className="text-[17px] font-semibold">New session</div>
            <div className="text-[12.5px] text-ink-3">Set it up, then let it run.</div>
          </div>
          <button onClick={close} className="rounded-xl p-2 text-ink-3 hover:bg-card hover:text-ink">
            <X size={17} />
          </button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Name">
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Model">
            <select className="field" value={model} onChange={(e) => setModel(e.target.value)}>
              {DEFAULT_MODELS.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Working folder" className="mt-3">
          <div className="flex gap-2">
            <input className="field font-mono !text-[12.5px]" placeholder={settings?.mock ? 'Demo mode, any path works' : 'C:\\Users\\you\\projects\\my-app'} value={cwd} onChange={(e) => setCwd(e.target.value)} />
            {inTauri() && (
              <button onClick={pickFolder} className="shrink-0 rounded-[10px] border border-line px-3 text-ink-2 hover:border-line-hi hover:text-ink" title="Browse">
                <FolderOpen size={16} />
              </button>
            )}
          </div>
        </Field>

        <Field label="First message" className="mt-3">
          <textarea ref={promptRef} className="field h-24" placeholder="What should this session work on?" value={prompt} onChange={(e) => setPrompt(e.target.value)} />
        </Field>

        <Field label="Priority" hint="Higher wins when two sessions want the same file" className="mt-4">
          <div className="flex gap-1.5">
            {[1, 2, 3, 4, 5].map((p) => (
              <button
                key={p}
                onClick={() => setPriority(p)}
                className={`relative h-9 flex-1 rounded-[10px] border text-[13px] font-medium transition ${priority === p ? 'border-transparent text-white' : 'border-line text-ink-2 hover:border-line-hi'}`}
              >
                {priority === p && <motion.div layoutId="prio" className="absolute inset-0 rounded-[10px] bg-[#6d5ce8]" transition={spring} />}
                <span className="relative">{p}</span>
              </button>
            ))}
          </div>
        </Field>

        <Field label="Knows about" className="mt-4">
          <Segmented
            id="aw"
            value={awareness}
            onChange={setAwareness}
            options={[
              { v: 'solo', label: 'Nobody', icon: <EyeOff size={14} />, tip: 'Works alone. Edits still get checked for clashes.' },
              { v: 'family', label: 'Its family', icon: <Users size={14} />, tip: 'Sees its family and sessions it is connected to.' },
              { v: 'everyone', label: 'Everyone', icon: <Eye size={14} />, tip: 'Sees every session on the canvas.' },
            ]}
          />
        </Field>

        <Field label="Permissions" className="mt-4">
          <Segmented
            id="perm"
            value={permission}
            onChange={setPermission}
            options={[
              { v: 'ask', label: 'Ask me', icon: <ShieldCheck size={14} />, tip: 'Asks before running commands or editing.' },
              { v: 'acceptEdits', label: 'Auto edits', icon: <ShieldEllipsis size={14} />, tip: 'Edits files freely, asks before commands.' },
              { v: 'auto', label: 'Full auto', icon: <ShieldAlert size={14} />, tip: 'Never asks. Only use in folders you trust.' },
            ]}
          />
        </Field>

        {families.length > 0 && (
          <Field label="Family" className="mt-4">
            <div className="flex flex-wrap gap-1.5">
              <Chip on={familyId === null} onClick={() => setFamilyId(null)} color="#6b6b7b" label="None" />
              {families.map((f) => (
                <Chip key={f.id} on={familyId === f.id} onClick={() => setFamilyId(f.id)} color={f.color} label={f.name} />
              ))}
            </div>
          </Field>
        )}

        <div className="mt-6 flex items-center justify-between">
          <div className="text-[11.5px] text-ink-3">
            <kbd className="rounded border border-line px-1 font-mono">Ctrl</kbd> + <kbd className="rounded border border-line px-1 font-mono">Enter</kbd> to start
          </div>
          <motion.button
            whileHover={{ scale: canStart ? 1.03 : 1 }}
            whileTap={{ scale: canStart ? 0.97 : 1 }}
            disabled={!canStart}
            onClick={start}
            className="flex items-center gap-2 rounded-[12px] bg-gradient-to-r from-[#7c6cf0] to-[#5b8def] px-5 py-2.5 text-[13.5px] font-semibold text-white shadow-[0_8px_24px_rgba(124,108,240,0.35)] disabled:opacity-40"
          >
            <Rocket size={15} /> Start session
          </motion.button>
        </div>
      </motion.div>
    </motion.div>
  );
}

function Field({ label, hint, className = '', children }: { label: string; hint?: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={`block ${className}`}>
      <div className="mb-1.5 flex items-baseline gap-2">
        <span className="text-[12px] font-medium text-ink-2">{label}</span>
        {hint && <span className="text-[11px] text-ink-3">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

function Segmented<T extends string>({
  id,
  value,
  onChange,
  options,
}: {
  id: string;
  value: T;
  onChange: (v: T) => void;
  options: { v: T; label: string; icon: React.ReactNode; tip: string }[];
}) {
  const tip = options.find((o) => o.v === value)?.tip;
  return (
    <div>
      <div className="flex gap-1 rounded-[12px] border border-line bg-[#17171c] p-1">
        {options.map((o) => (
          <button key={o.v} onClick={() => onChange(o.v)} className={`relative flex h-8 flex-1 items-center justify-center gap-1.5 rounded-[9px] text-[12.5px] transition ${value === o.v ? 'text-ink' : 'text-ink-3 hover:text-ink-2'}`}>
            {value === o.v && <motion.div layoutId={`seg-${id}`} className="absolute inset-0 rounded-[9px] bg-card-hi shadow" transition={spring} />}
            <span className="relative flex items-center gap-1.5">
              {o.icon}
              {o.label}
            </span>
          </button>
        ))}
      </div>
      <div className="mt-1.5 text-[11.5px] text-ink-3">{tip}</div>
    </div>
  );
}

function Chip({ on, onClick, color, label }: { on: boolean; onClick: () => void; color: string; label: string }) {
  return (
    <button onClick={onClick} className={`flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12px] transition ${on ? 'text-ink' : 'border-line text-ink-3 hover:text-ink-2'}`} style={on ? { borderColor: color, background: `color-mix(in srgb, ${color} 14%, transparent)` } : {}}>
      <span className="h-2 w-2 rounded-full" style={{ background: color }} />
      {label}
    </button>
  );
}
