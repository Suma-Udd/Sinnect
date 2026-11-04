// In-app updates from GitHub Releases (signed, via the Tauri updater).
import { create } from 'zustand';
import { inTauri } from './engine';

type Phase = 'idle' | 'checking' | 'latest' | 'available' | 'downloading' | 'installing' | 'error';

interface UpdateState {
  phase: Phase;
  current: string | null;
  version: string | null;
  notes: string | null;
  progress: number; // 0..1, -1 when the size is unknown
  error: string | null;
  dismissed: boolean;
  set(p: Partial<UpdateState>): void;
}

export const useUpdate = create<UpdateState>((set) => ({
  phase: 'idle',
  current: null,
  version: null,
  notes: null,
  progress: 0,
  error: null,
  dismissed: false,
  set: (p) => set(p),
}));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pending: any = null;

export async function loadVersion() {
  if (!inTauri()) return;
  try {
    const { getVersion } = await import('@tauri-apps/api/app');
    useUpdate.getState().set({ current: await getVersion() });
  } catch {
    /* not important */
  }
}

/** Looks for a newer release. quiet = launch check, so failures stay silent. */
export async function checkForUpdate(quiet = false) {
  const s = useUpdate.getState();
  if (!inTauri()) {
    if (!quiet) s.set({ phase: 'error', error: 'Updates only work in the desktop app.' });
    return;
  }
  if (s.phase === 'downloading' || s.phase === 'installing') return;
  s.set({ phase: 'checking', error: null });
  try {
    const { check } = await import('@tauri-apps/plugin-updater');
    const update = await check();
    if (update) {
      pending = update;
      s.set({ phase: 'available', version: update.version, notes: update.body ?? null, dismissed: false });
    } else {
      s.set({ phase: 'latest' });
    }
  } catch (err) {
    s.set({ phase: quiet ? 'idle' : 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

export async function installUpdate() {
  const s = useUpdate.getState();
  if (!pending) return;
  let total = 0;
  let got = 0;
  try {
    s.set({ phase: 'downloading', progress: 0 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await pending.download((e: any) => {
      if (e.event === 'Started') total = e.data.contentLength ?? 0;
      else if (e.event === 'Progress') {
        got += e.data.chunkLength;
        useUpdate.getState().set({ progress: total ? got / total : -1 });
      }
    });
    s.set({ phase: 'installing', progress: 1 });
    const { invoke } = await import('@tauri-apps/api/core');
    // The installer can't replace the engine while it runs, so stop it first.
    await invoke('stop_engine_for_update').catch(() => {});
    await pending.install();
    const { relaunch } = await import('@tauri-apps/plugin-process');
    await relaunch();
  } catch (err) {
    s.set({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
  }
}

/** Launch check, a few seconds in so it doesn't compete with startup. */
export function startUpdateChecks() {
  loadVersion();
  setTimeout(() => checkForUpdate(true), 4000);
  // People leave the app open for days: look again every 6 hours.
  setInterval(() => checkForUpdate(true), 6 * 60 * 60 * 1000);
}
