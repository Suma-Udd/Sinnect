// Saving and loading the whole board.

import type { SessionState } from '@engine/protocol';
import { useApp, type AppNode } from './store';
import { toast } from 'sonner';
import { onEngine, send } from './engine';
import { hasOwnFile, isOpenWorkspace } from './workspace-file';

export { isOpenWorkspace };

export interface WorkspaceFile {
  version: 1;
  nodes: AppNode[];
  sessions: Pick<SessionState, 'id' | 'config' | 'sdkSessionId' | 'tokens' | 'costUsd' | 'goal' | 'filesTouched' | 'turns'>[];
  links: ReturnType<typeof useApp.getState>['links'];
  families: ReturnType<typeof useApp.getState>['families'];
  viewport: ReturnType<typeof useApp.getState>['viewport'];
}

export function serialize(): WorkspaceFile {
  const s = useApp.getState();
  // Helpers are throwaway unless you pinned them. A session without a card can't be resumed from the file:
  // it's one of the previous board's, still wrapping up after a switch, whose last update came in late.
  const cards = new Set(s.nodes.map((n) => n.id));
  const skip = new Set(Object.values(s.sessions).filter((x) => (x.config.parentId && !s.pinned[x.id]) || !cards.has(x.id)).map((x) => x.id));
  return {
    version: 1,
    nodes: s.nodes.filter((n) => !skip.has(n.id)).map((n) => ({ id: n.id, type: n.type, position: n.position, data: n.data, width: n.width, height: n.height, zIndex: n.zIndex }) as AppNode),
    sessions: Object.values(s.sessions).filter((x) => !skip.has(x.id)).map((x) => ({
      id: x.id,
      config: { ...x.config, prompt: '' },
      sdkSessionId: x.sdkSessionId,
      tokens: x.tokens,
      costUsd: x.costUsd,
      goal: x.goal,
      filesTouched: x.filesTouched,
      turns: x.turns,
    })),
    links: s.links,
    families: s.families,
    viewport: s.viewport,
  };
}

/** Put a saved board on the canvas. Sessions come back "dormant" with a Resume button. */
export function applyWorkspace(w: WorkspaceFile, name?: string) {
  const s = useApp.getState();
  const sessions: Record<string, SessionState> = {};
  const dormant: Record<string, boolean> = {};
  for (const x of w.sessions) {
    if (s.sessions[x.id] && s.sessions[x.id].status !== 'stopped') {
      sessions[x.id] = s.sessions[x.id];
      continue;
    }
    sessions[x.id] = {
      ...x,
      status: 'stopped',
      activity: 'Saved',
      startedAt: Date.now(),
    } as SessionState;
    dormant[x.id] = true;
  }
  s.set({ nodes: w.nodes, sessions, dormant, viewport: w.viewport, workspaceName: name ?? s.workspaceName });
  send({ t: 'links.set', links: w.links });
  send({ t: 'families.set', families: w.families });
  window.dispatchEvent(new CustomEvent('sinnect:viewport', { detail: w.viewport }));
}

export function saveWorkspace(name: string) {
  useApp.getState().set({ workspaceName: name });
  send({ t: 'workspace.save', name, data: serialize() });
}

export async function loadWorkspace(name: string) {
  const s = useApp.getState();
  const running = Object.values(s.sessions).filter((x) => !s.dormant[x.id] && x.status !== 'stopped');
  const own = hasOwnFile(s.workspaceName, s.workspaces);
  const kept = own ? ` "${s.workspaceName}" is saved first, and its sessions come back with Resume when you open it again.` : '';
  if (running.length && !confirm(`Stop ${running.length} running session(s) and open "${name}"?${kept}`)) return;
  if (own) saveWorkspace(s.workspaceName);
  // Load only once the old sessions are gone: a late "removed" would take the card of a session
  // that's on the new board too (reopening the open workspace, or one saved under two names).
  await clearBoard();
  send({ t: 'workspace.load', name });
}

/** Close every session and empty the canvas: cards, links, families. Resolves once the engine has removed them. */
function clearBoard(): Promise<void> {
  const s = useApp.getState();
  const live = Object.values(s.sessions).filter((x) => !s.dormant[x.id]).map((x) => x.id);
  const gone = untilRemoved(live);
  for (const id of live) send({ t: 'session.remove', id });
  s.set({ sessions: {}, dormant: {}, nodes: [], feeds: {}, expanded: null });
  send({ t: 'links.set', links: [] });
  send({ t: 'families.set', families: [] });
  return gone;
}

function untilRemoved(ids: string[]): Promise<void> {
  if (!ids.length) return Promise.resolve();
  const left = new Set(ids);
  return new Promise((resolve) => {
    const finish = () => {
      off();
      clearTimeout(timer);
      resolve();
    };
    const off = onEngine((m) => {
      if (m.t === 'session.removed' && left.delete(m.id) && !left.size) finish();
    });
    // A session that reflects before it goes takes one model turn. Don't wait forever if the engine never answers.
    const timer = setTimeout(finish, 30_000);
  });
}

const sessionCount = () => Object.keys(useApp.getState().sessions).length;

/** Start over on an empty, unsaved board. A saved board is saved into its own file first, not thrown away. */
export function newWorkspace() {
  const s = useApp.getState();
  const n = sessionCount();
  const own = hasOwnFile(s.workspaceName, s.workspaces);
  const ask = own
    ? `Start an empty workspace? "${s.workspaceName}" is saved first, and its ${n} session(s) come back with Resume when you open it again.`
    : `Close ${n} session(s) and start an empty workspace? This board was never saved, so it is lost.`;
  if (n && !confirm(ask)) return;
  if (own) saveWorkspace(s.workspaceName);
  clearBoard();
  useApp.getState().set({ workspaceName: 'My workspace' });
}

/** Delete a saved workspace. Deleting the open one also closes its sessions and empties the board. */
export function deleteWorkspace(name: string) {
  const open = isOpenWorkspace(name, useApp.getState().workspaceName);
  const n = open ? sessionCount() : 0;
  const ask = n ? `Delete "${name}" and close its ${n} session(s)? This can't be undone.` : `Delete the saved workspace "${name}"? This can't be undone.`;
  if (!confirm(ask)) return;
  send({ t: 'workspace.delete', name });
  if (!open) return;
  clearBoard();
  useApp.getState().set({ workspaceName: 'My workspace' });
  toast(`Deleted "${name}"`);
}

let restoreTried = false;

/** Autosave every few seconds while things change, and restore on first launch. */
export function startAutosave() {
  let last = '';
  const tick = () => {
    const s = useApp.getState();
    if (s.conn !== 'open') return;
    const data = serialize();
    const json = JSON.stringify(data);
    if (json === last) return;
    last = json;
    send({ t: 'workspace.save', name: '__autosave', data: { ...data, name: s.workspaceName } });
  };
  setInterval(tick, 4000);
  window.addEventListener('beforeunload', tick);

  onEngine((msg) => {
    if (msg.t === 'ready' && !restoreTried) {
      restoreTried = true;
      if (msg.snapshot.sessions.length === 0 && useApp.getState().nodes.length === 0) send({ t: 'workspace.load', name: '__autosave' });
      send({ t: 'workspace.list' });
    }
    if (msg.t === 'workspace.data' && msg.data) {
      const w = msg.data as WorkspaceFile & { name?: string };
      if (w.version === 1) applyWorkspace(w, msg.name === '__autosave' ? w.name : msg.name);
    }
  });
}
