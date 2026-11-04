import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { AnimatePresence, motion } from 'motion/react';
import { X } from 'lucide-react';
import { useApp } from '../store';
import { useShallow } from 'zustand/react/shallow';
import { send } from '../engine';

/**
 * A link between two sessions. Every hub message between them sends a little
 * light along the line, so you can watch them talk.
 */
export const PulseEdge = memo(function PulseEdge(props: EdgeProps) {
  const { id, source, target, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected } = props;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.35 });
  const pulses = useApp(useShallow((s) => s.pulses.filter((p) => (p.from === source && p.to === target) || (p.from === target && p.to === source))));
  const count = useApp((s) => s.messages.filter((m) => (m.from === source && m.to === target) || (m.from === target && m.to === source)).length);
  const bothActive = useApp((s) => {
    const a = s.sessions[source]?.status;
    const b = s.sessions[target]?.status;
    const on = (x?: string) => x === 'thinking' || x === 'working';
    return on(a) && on(b);
  });

  const remove = () => {
    const links = useApp.getState().links.filter((l) => l.id !== id);
    send({ t: 'links.set', links });
  };

  return (
    <>
      <BaseEdge
        id={id}
        path={path}
        style={{
          stroke: selected ? '#ff6b4a' : bothActive ? '#ff6b4a' : '#4c4c50',
          strokeWidth: selected ? 2.5 : 2,
          transition: 'stroke 0.3s ease',
        }}
      />
      {bothActive && (
        <path d={path} fill="none" stroke="#ff6b4a" strokeOpacity={0.35} strokeWidth={2} strokeDasharray="4 14">
          <animate attributeName="stroke-dashoffset" from="36" to="0" dur="1.2s" repeatCount="indefinite" />
        </path>
      )}
      <AnimatePresence>
        {pulses.map((p) => {
          const forward = p.from === source;
          return (
            <motion.g key={p.id} initial={{ opacity: 1 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <circle r={5} fill="#ffc2b3" style={{ filter: 'drop-shadow(0 0 6px #ff6b4a)' }}>
                <animateMotion dur="1.1s" repeatCount="1" fill="freeze" path={path} keyPoints={forward ? '0;1' : '1;0'} keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.2 1" />
                <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.85;1" dur="1.1s" fill="freeze" />
              </circle>
            </motion.g>
          );
        })}
      </AnimatePresence>
      <EdgeLabelRenderer>
        <div
          className="nodrag nopan pointer-events-auto absolute flex items-center gap-1"
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          {count > 0 && (
            <motion.div key={count} initial={{ scale: 1.4 }} animate={{ scale: 1 }} className="rounded-full border border-line bg-panel px-2 py-0.5 font-mono text-[10.5px] text-ink-2">
              {count} msg
            </motion.div>
          )}
          {selected && (
            <button onClick={remove} className="rounded-full border border-line bg-panel p-1 text-ink-2 hover:text-st-error" title="Disconnect">
              <X size={11} />
            </button>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
