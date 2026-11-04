import { useEffect } from 'react';
import { ReactFlowProvider, useReactFlow, type Viewport } from '@xyflow/react';
import { AnimatePresence } from 'motion/react';
import { Toaster, toast } from 'sonner';
import { Canvas } from './canvas/Canvas';
import { DynamicIsland } from './island/DynamicIsland';
import { ExpandedSession } from './panels/ExpandedSession';
import { SetupCard } from './panels/SetupCard';
import { SignInCard } from './panels/SignInCard';
import { SettingsSheet, Toolbar, WorkspacesSheet } from './panels/Toolbar';
import { useApp } from './store';
import { connect, onEngine } from './engine';
import { startAutosave } from './workspace';

let booted = false;

function Shell() {
  const expanded = useApp((s) => s.expanded);
  const setup = useApp((s) => s.setup);
  const rf = useReactFlow();

  useEffect(() => {
    if (booted) return;
    booted = true;
    startAutosave();
    connect();
    onEngine((m) => {
      if (m.t === 'toast') (m.level === 'error' ? toast.error : m.level === 'warn' ? toast.warning : toast)(m.text);
    });
    if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
    // Old message pulses are only for the animation; drop them.
    setInterval(() => {
      const s = useApp.getState();
      if (s.pulses.length && s.pulses.some((p) => Date.now() - p.at > 2500)) s.set({ pulses: s.pulses.filter((p) => Date.now() - p.at <= 2500) });
    }, 1000);
  }, []);

  useEffect(() => {
    const onVp = (e: Event) => {
      const vp = (e as CustomEvent<Viewport | null>).detail;
      if (vp) rf.setViewport(vp, { duration: 400 });
      else setTimeout(() => rf.fitView({ padding: 0.3, duration: 400 }), 50);
    };
    window.addEventListener('sinnect:viewport', onVp);
    return () => window.removeEventListener('sinnect:viewport', onVp);
  }, [rf]);

  return (
    <div className="relative h-full w-full">
      <Canvas />
      <Toolbar />
      <DynamicIsland />
      <AnimatePresence>{expanded && <ExpandedSession key={expanded} />}</AnimatePresence>
      <AnimatePresence>{setup && <SetupCard />}</AnimatePresence>
      <SignInCard />
      <WorkspacesSheet />
      <SettingsSheet />
      <Toaster theme="dark" position="bottom-center" toastOptions={{ style: { background: '#1e1e1f', border: '1px solid #363638', color: '#ededec' } }} />
    </div>
  );
}

export default function App() {
  return (
    <ReactFlowProvider>
      <Shell />
    </ReactFlowProvider>
  );
}
