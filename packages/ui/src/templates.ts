// Session templates: saved new-session setups. The engine stores them; this file turns them into sessions.

import type { Family, SessionConfig, SessionTemplate } from '@engine/protocol';
import { useApp, type AppNode } from './store';
import { send } from './engine';
import { CARD_H, CARD_W } from './actions';
import { uid } from './lib';

export const LAST_SETUP = 'sinnect.lastSetup';

export function loadLastSetup(): Partial<SessionConfig> {
  try {
    return JSON.parse(localStorage.getItem(LAST_SETUP) || '{}');
  } catch {
    return {};
  }
}

export function rememberSetup(c: Pick<SessionConfig, 'cwd' | 'model' | 'awareness' | 'permission'>) {
  localStorage.setItem(LAST_SETUP, JSON.stringify({ cwd: c.cwd, model: c.model, awareness: c.awareness, permission: c.permission }));
}

/** Template family by id, then by name (families get recreated), else none. */
export function templateFamily(t: SessionTemplate, families: Family[]): string | null {
  if (t.familyId && families.some((f) => f.id === t.familyId)) return t.familyId;
  if (t.familyName) {
    const name = t.familyName.trim().toLowerCase();
    const f = families.find((x) => x.name.trim().toLowerCase() === name);
    if (f) return f.id;
  }
  return null;
}

/** "Reviewer", then "Reviewer 2", "Reviewer 3"... so cards stay tellable apart. */
function freshName(base: string) {
  const taken = new Set(Object.values(useApp.getState().sessions).map((s) => s.config.name.toLowerCase()));
  if (!taken.has(base.toLowerCase())) return base;
  for (let i = 2; ; i++) if (!taken.has(`${base} ${i}`.toLowerCase())) return `${base} ${i}`;
}

/** Don't drop a card exactly on top of another one. */
function freePosition(p: { x: number; y: number }) {
  const nodes = useApp.getState().nodes.filter((n) => n.type === 'session');
  let pos = p;
  for (let i = 0; i < 12 && nodes.some((n) => Math.abs(n.position.x - pos.x) < 24 && Math.abs(n.position.y - pos.y) < 24); i++) {
    pos = { x: pos.x + 32, y: pos.y + 32 };
  }
  return pos;
}

/**
 * Start a session from a template, centred on `center` (board coords).
 * Folder: the one given, else the last used one. No folder at all = open the setup card prefilled instead.
 * Returns the new session id, or null when it opened the card.
 */
export function spawnFromTemplate(t: SessionTemplate, center: { x: number; y: number }, folder?: string): string | null {
  const st = useApp.getState();
  const cwd = (folder?.trim() || loadLastSetup().cwd?.trim() || (st.settings?.mock ? '/demo/project' : '')).trim();
  if (!cwd) {
    st.set({ setup: { position: { x: center.x - CARD_W / 2, y: center.y - 40 }, familyId: templateFamily(t, st.families), template: t } });
    return null;
  }
  const id = uid('s');
  const config: SessionConfig = {
    name: freshName(t.name.trim() || 'Session'),
    cwd,
    model: t.model,
    prompt: t.prompt,
    priority: t.priority,
    awareness: t.awareness,
    permission: t.permission,
    familyId: templateFamily(t, st.families),
  };
  rememberSetup(config);
  const node: AppNode = { id, type: 'session', position: freePosition({ x: center.x - CARD_W / 2, y: center.y - CARD_H / 2 }), data: { sessionId: id } };
  st.set({ nodes: [...st.nodes, node], setup: null });
  send({ t: 'session.create', id, config });
  return id;
}

export function saveTemplate(t: SessionTemplate) {
  // Optimistic: the engine answers with the full list, which replaces this.
  const st = useApp.getState();
  const i = st.templates.findIndex((x) => x.id === t.id);
  st.set({ templates: i >= 0 ? st.templates.map((x) => (x.id === t.id ? t : x)) : [...st.templates, t] });
  send({ t: 'template.save', template: t });
}

export function deleteTemplate(id: string) {
  const st = useApp.getState();
  st.set({ templates: st.templates.filter((x) => x.id !== id) });
  send({ t: 'template.delete', id });
}
