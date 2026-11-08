import { useEffect } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { KeyRound, LogIn } from 'lucide-react';
import { useApp } from '../store';
import { send } from '../engine';

/** First-run card: shows until the user is signed in (or picks an API key). */
export function SignInCard() {
  const settings = useApp((s) => s.settings);
  const guide = useApp((s) => s.guideOpen);
  const show = !guide && !!settings && !settings.mock && settings.authMode === 'local' && !settings.signedIn && !settings.hasGeminiKey && !settings.hasOpenaiKey && !settings.chatgpt?.signedIn;

  // Coming back to the window after signing in elsewhere: check again.
  useEffect(() => {
    if (!show) return;
    const onFocus = () => send({ t: 'auth.check' });
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [show]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 24, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 16, scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
          className="pointer-events-auto absolute bottom-8 left-1/2 z-40 w-[440px] -translate-x-1/2 rounded-[20px] border border-line bg-panel/95 p-5 shadow-[0_24px_60px_rgba(0,0,0,0.5)] backdrop-blur-xl"
        >
          <div className="mb-1 text-[15px] font-semibold">Sign in to get started</div>
          <div className="mb-4 text-[12.5px] leading-relaxed text-ink-2">
            Sinnect runs your sessions on your Claude account. Click below, a small window opens, follow the steps there and come back. This only happens once.
          </div>
          <div className="flex gap-2">
            <motion.button
              whileHover={{ scale: 1.02 }}
              whileTap={{ scale: 0.97 }}
              onClick={() => send({ t: 'auth.login' })}
              className="flex h-10 flex-1 items-center justify-center gap-2 rounded-[12px] bg-accent text-[13px] font-semibold text-white shadow-[0_8px_24px_rgba(255,107,74,0.28)] hover:bg-accent-hi"
            >
              <LogIn size={15} /> Sign in with Claude
            </motion.button>
            <button
              onClick={() => (send({ t: 'settings.set', patch: { authMode: 'apiKey' } }), useApp.getState().set({ settingsOpen: true }))}
              className="flex h-10 items-center gap-2 rounded-[12px] border border-line px-3.5 text-[12.5px] text-ink-2 transition hover:border-line-hi hover:text-ink"
            >
              <KeyRound size={14} /> Use an API key
            </button>
          </div>
          <button onClick={() => useApp.getState().set({ settingsOpen: true })} className="mt-3 text-[11.5px] text-ink-3 underline-offset-2 transition hover:text-ink-2 hover:underline">
            Only using Gemini or ChatGPT? Set that up in Settings instead
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
