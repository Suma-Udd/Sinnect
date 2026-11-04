import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';

// Opening animation: two session cards fly in, a wire draws between them,
// a pulse travels across, the name rises in, then it all lifts away.
const EASE = [0.22, 1, 0.36, 1] as const;
const WIRE = 'M 46 40 C 96 40 84 120 134 120';

export function Intro() {
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const [show, setShow] = useState(!reduce);

  useEffect(() => {
    if (!show) return;
    const t = setTimeout(() => setShow(false), 2300);
    return () => clearTimeout(t);
  }, [show]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          key="intro"
          onClick={() => setShow(false)}
          exit={{ opacity: 0, scale: 1.04, filter: 'blur(6px)' }}
          transition={{ duration: 0.5, ease: EASE }}
          className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-canvas"
          style={{ backgroundImage: 'radial-gradient(#2a2a2c 1px, transparent 1px)', backgroundSize: '22px 22px' }}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.6 }}
            animate={{ opacity: 0.55, scale: 1 }}
            transition={{ duration: 1.4, ease: EASE }}
            className="pointer-events-none absolute h-[420px] w-[420px] rounded-full"
            style={{ background: 'radial-gradient(circle, rgba(255,107,74,0.16), transparent 65%)' }}
          />
          <svg width="180" height="160" viewBox="0 0 180 160" className="relative overflow-visible">
            <motion.path
              d={WIRE}
              fill="none"
              stroke="#ff6b4a"
              strokeWidth={4}
              strokeLinecap="round"
              initial={{ pathLength: 0, opacity: 0 }}
              animate={{ pathLength: 1, opacity: 1 }}
              transition={{ delay: 0.45, duration: 0.55, ease: 'easeInOut' }}
            />
            <motion.circle
              r={5}
              fill="#ffc2b3"
              style={{ offsetPath: `path('${WIRE}')`, filter: 'drop-shadow(0 0 8px #ff6b4a)' }}
              initial={{ offsetDistance: '0%', opacity: 0 }}
              animate={{ offsetDistance: '100%', opacity: [0, 1, 1, 0] }}
              transition={{ delay: 0.95, duration: 0.55, ease: 'easeInOut' }}
            />
            <motion.rect
              x={6} y={22} width={40} height={36} rx={11} fill="#ff6b4a"
              initial={{ x: -60, opacity: 0, rotate: -12 }}
              animate={{ x: 0, opacity: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 20 }}
            />
            <motion.rect
              x={134} y={102} width={40} height={36} rx={11} fill="#ededec"
              initial={{ x: 60, opacity: 0, rotate: 12 }}
              animate={{ x: 0, opacity: 1, rotate: 0 }}
              transition={{ type: 'spring', stiffness: 260, damping: 20, delay: 0.12 }}
            />
            <motion.rect
              x={134} y={102} width={40} height={36} rx={11} fill="none" stroke="#ff6b4a" strokeWidth={2}
              initial={{ opacity: 0, scale: 1 }}
              animate={{ opacity: [0, 0.9, 0], scale: [1, 1.35, 1.6] }}
              style={{ transformOrigin: '154px 120px' }}
              transition={{ delay: 1.45, duration: 0.6, ease: 'easeOut' }}
            />
          </svg>
          <div className="relative mt-7 flex text-[34px] font-semibold tracking-tight text-ink">
            {'Sinnect'.split('').map((ch, i) => (
              <motion.span
                key={i}
                initial={{ y: 18, opacity: 0, filter: 'blur(4px)' }}
                animate={{ y: 0, opacity: 1, filter: 'blur(0px)' }}
                transition={{ delay: 0.9 + i * 0.045, duration: 0.45, ease: EASE }}
              >
                {ch}
              </motion.span>
            ))}
          </div>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            transition={{ delay: 1.35, duration: 0.5 }}
            className="relative mt-2 text-[13px] text-ink-3"
          >
            sessions, connected
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
