import { memo } from 'react';
import { EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { motion } from 'motion/react';
import { useApp } from '../store';
import { modelLabel } from '../lib';

/**
 * Boss to helper wire. It draws itself in when the helper spawns, streams
 * while the helper works, and sends one light back to the boss when the
 * summary is handed over.
 */
export const WorkerEdge = memo(function WorkerEdge(props: EdgeProps) {
  const { sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, target } = props;
  const [path, labelX, labelY] = getBezierPath({ sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, curvature: 0.3 });
  const st = useApp((s) => s.sessions[target]);
  if (!st) return null;
  const working = st.status === 'thinking' || st.status === 'working' || st.status === 'starting' || st.status === 'waiting' || st.status === 'blocked';
  const done = !!st.summary;
  return (
    <>
      <motion.path
        d={path}
        fill="none"
        stroke={done ? '#a3e635' : '#ff6b4a'}
        strokeOpacity={done ? 0.55 : 0.7}
        strokeWidth={2}
        strokeDasharray={done ? undefined : '6 6'}
        initial={{ pathLength: 0, opacity: 0 }}
        animate={{ pathLength: 1, opacity: 1 }}
        transition={{ duration: 0.55, ease: [0.22, 1, 0.36, 1] }}
        style={{ transition: 'stroke 0.4s ease' }}
      />
      {working && (
        <path d={path} fill="none" stroke="#ff8a6e" strokeOpacity={0.9} strokeWidth={2.5} strokeLinecap="round" strokeDasharray="2 22">
          <animate attributeName="stroke-dashoffset" from="48" to="0" dur="0.9s" repeatCount="indefinite" />
        </path>
      )}
      {done && (
        <circle r={5} fill="#d9f99d" style={{ filter: 'drop-shadow(0 0 7px #a3e635)' }}>
          <animateMotion dur="0.9s" repeatCount="1" fill="freeze" path={path} keyPoints="1;0" keyTimes="0;1" calcMode="spline" keySplines="0.4 0 0.2 1" />
          <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;0.1;0.85;1" dur="0.9s" fill="freeze" />
        </circle>
      )}
      <EdgeLabelRenderer>
        <div className="nodrag nopan pointer-events-none absolute" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{ opacity: 1, scale: 1 }}
            transition={{ delay: 0.35 }}
            className="rounded-full border border-line bg-panel px-2 py-0.5 font-mono text-[10px] text-ink-3"
          >
            {modelLabel(st.config.model)}
          </motion.div>
        </div>
      </EdgeLabelRenderer>
    </>
  );
});
