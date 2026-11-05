import { memo, useState } from 'react';
import { NodeResizer, type NodeProps } from '@xyflow/react';
import { Plus, Trash2 } from 'lucide-react';
import { useApp, type AppNode, type FamilyNodeData, type NoteNodeData } from '../store';
import { send } from '../engine';
import { FAMILY_COLORS } from '../lib';
import { syncTemplateFamilyName } from '../templates';

export const FamilyNode = memo(function FamilyNode({ id, data, selected, width, height }: NodeProps<AppNode & { data: FamilyNodeData }>) {
  const fam = useApp((s) => s.families.find((f) => f.id === data.familyId));
  const count = useApp((s) => Object.values(s.sessions).filter((x) => x.config.familyId === data.familyId).length);
  const [editing, setEditing] = useState(false);
  if (!fam) return null;
  const c = fam.color;

  const rename = (name: string) => {
    const next = name || fam.name;
    const families = useApp.getState().families.map((f) => (f.id === fam.id ? { ...f, name: next } : f));
    send({ t: 'families.set', families });
    syncTemplateFamilyName(fam.id, next);
  };
  const recolor = () => {
    const i = FAMILY_COLORS.indexOf(c);
    const families = useApp.getState().families.map((f) => (f.id === fam.id ? { ...f, color: FAMILY_COLORS[(i + 1) % FAMILY_COLORS.length] } : f));
    send({ t: 'families.set', families });
  };
  const remove = () => {
    const st = useApp.getState();
    for (const s of Object.values(st.sessions)) if (s.config.familyId === fam.id) send({ t: 'session.update', id: s.id, patch: { familyId: null } });
    send({ t: 'families.set', families: st.families.filter((f) => f.id !== fam.id) });
    st.set({ nodes: st.nodes.filter((n) => n.id !== id) });
  };
  const addHere = () => {
    const n = useApp.getState().nodes.find((x) => x.id === id);
    if (!n) return;
    useApp.getState().set({ setup: { position: { x: n.position.x + 40, y: n.position.y + 70 }, familyId: fam.id } });
  };

  return (
    <div
      className="group relative h-full w-full rounded-[26px] border-2 border-dashed transition-colors"
      style={{
        width,
        height,
        borderColor: `color-mix(in srgb, ${c} ${selected ? 80 : 40}%, transparent)`,
        background: `color-mix(in srgb, ${c} 5%, transparent)`,
      }}
    >
      <NodeResizer isVisible={selected} minWidth={340} minHeight={220} lineStyle={{ borderColor: 'transparent' }} handleStyle={{ width: 10, height: 10, borderRadius: 4, background: c, border: 'none' }} />
      <div className="absolute left-5 top-4 flex items-center gap-2.5">
        <button onClick={recolor} className="nodrag h-3.5 w-3.5 rounded-full ring-4 transition hover:scale-125" style={{ background: c, ['--tw-ring-color' as string]: `color-mix(in srgb, ${c} 25%, transparent)` }} title="Change color" />
        {editing ? (
          <input
            autoFocus
            defaultValue={fam.name}
            className="nodrag field !w-48 !py-1 text-[15px] font-semibold"
            onBlur={(e) => {
              rename(e.target.value.trim());
              setEditing(false);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <div onDoubleClick={() => setEditing(true)} className="text-[15px] font-semibold" style={{ color: c }}>
            {fam.name}
          </div>
        )}
        <div className="text-[12px] text-ink-3">{count} session{count === 1 ? '' : 's'}</div>
      </div>
      <div className="absolute right-4 top-3.5 flex gap-1 opacity-0 transition group-hover:opacity-100">
        <button onClick={addHere} className="nodrag rounded-lg p-1.5 text-ink-2 hover:bg-card-hi hover:text-ink" title="New session in this family">
          <Plus size={15} />
        </button>
        <button onClick={remove} className="nodrag rounded-lg p-1.5 text-ink-2 hover:bg-card-hi hover:text-st-error" title="Remove family (keeps sessions)">
          <Trash2 size={15} />
        </button>
      </div>
    </div>
  );
});

export const NoteNode = memo(function NoteNode({ id, data, selected }: NodeProps<AppNode & { data: NoteNodeData }>) {
  const update = (text: string) => {
    const st = useApp.getState();
    st.set({ nodes: st.nodes.map((n) => (n.id === id ? ({ ...n, data: { text } } as AppNode) : n)) });
  };
  return (
    <div className="rounded-2xl border p-3 shadow-xl" style={{ width: 220, background: '#2a2614', borderColor: selected ? '#fbbf24' : '#4a4320' }}>
      <textarea
        defaultValue={data.text}
        onBlur={(e) => update(e.target.value)}
        placeholder="Write a note…"
        className="nodrag nowheel h-24 w-full resize-none bg-transparent text-[13px] leading-relaxed text-amber-100 outline-none placeholder:text-amber-200/40"
      />
    </div>
  );
});
