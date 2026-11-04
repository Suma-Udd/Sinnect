import { AnimatePresence, motion } from 'motion/react';
import { Download, Sparkles, X } from 'lucide-react';
import { installUpdate, useUpdate } from '../updater';

/** "New version" card that slides in from the bottom right. */
export function UpdateCard() {
  const { phase, version, current, notes, progress, error, dismissed, set } = useUpdate();
  const busy = phase === 'downloading' || phase === 'installing';
  const show = !dismissed && (phase === 'available' || busy || (phase === 'error' && !!version));
  const pct = progress < 0 ? null : Math.round(progress * 100);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 30, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 20, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 380, damping: 30 }}
          className="absolute right-5 bottom-5 z-50 w-[340px] overflow-hidden rounded-[18px] border border-line bg-panel/95 shadow-[0_24px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl"
        >
          <div className="p-4">
            <div className="mb-1 flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-accent/15 text-accent">
                <Sparkles size={15} />
              </div>
              <div className="text-[14px] font-semibold">Sinnect {version} is out</div>
              {!busy && (
                <button onClick={() => set({ dismissed: true })} className="ml-auto rounded-md p-1 text-ink-3 transition hover:bg-card-hi hover:text-ink" title="Later">
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="mb-3 text-[12px] text-ink-3">{current ? `You have ${current}.` : 'A new version is ready.'} Your board is saved and comes back after the restart, running sessions can be resumed.</div>
            {notes && phase === 'available' && (
              <div className="mb-3 max-h-28 overflow-y-auto rounded-[10px] bg-[#1a1a1a] px-3 py-2 text-[12px] leading-relaxed whitespace-pre-wrap text-ink-2">{notes}</div>
            )}
            {phase === 'error' && <div className="mb-3 text-[12px] text-st-error">{error}</div>}
            {busy ? (
              <div>
                <div className="mb-1.5 flex justify-between text-[11.5px] text-ink-3">
                  <span>{phase === 'installing' ? 'Installing, Sinnect will restart' : 'Downloading'}</span>
                  <span className="font-mono">{pct === null ? '' : `${pct}%`}</span>
                </div>
                <div className="h-1.5 overflow-hidden rounded-full bg-card-hi">
                  <motion.div className="h-full rounded-full bg-accent" animate={{ width: pct === null ? '60%' : `${pct}%` }} transition={{ ease: 'easeOut' }} />
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <motion.button
                  whileHover={{ scale: 1.02 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => installUpdate()}
                  className="flex h-9 flex-1 items-center justify-center gap-2 rounded-[11px] bg-accent text-[12.5px] font-semibold text-white hover:bg-accent-hi"
                >
                  <Download size={14} /> {phase === 'error' ? 'Try again' : 'Update and restart'}
                </motion.button>
                <button onClick={() => set({ dismissed: true })} className="h-9 rounded-[11px] border border-line px-3 text-[12.5px] text-ink-2 transition hover:border-line-hi hover:text-ink">
                  Later
                </button>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
