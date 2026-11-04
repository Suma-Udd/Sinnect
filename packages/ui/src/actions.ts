// Board actions shared by the canvas, the command palette and notifications.

import type { useReactFlow } from '@xyflow/react';
import { useApp, type AppNode } from './store';
import { send } from './engine';
import { FAMILY_COLORS, uid } from './lib';

type Flow = ReturnType<typeof useReactFlow>;
type Pos = { x: number; y: number };

export const CARD_W = 280;
export const CARD_H = 150;

/** Middle of the visible canvas, in board coordinates. */
export const viewCenter = (rf: Flow): Pos => rf.screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 });

export function openSetup(pos: Pos, familyId: string | null = null) {
  useApp.getState().set({ setup: { position: { x: pos.x - CARD_W / 2, y: pos.y - 40 }, familyId } });
}

export function newFamily(pos: Pos) {
  const st = useApp.getState();
  const fam = { id: uid('f'), name: `Family ${st.families.length + 1}`, color: FAMILY_COLORS[st.families.length % FAMILY_COLORS.length] };
  send({ t: 'families.set', families: [...st.families, fam] });
  const node: AppNode = { id: `fam-${fam.id}`, type: 'family', position: { x: pos.x - 300, y: pos.y - 200 }, data: { familyId: fam.id }, width: 640, height: 420, zIndex: -1 };
  st.set({ nodes: [node, ...st.nodes] });
}

export function newNote(pos: Pos) {
  const st = useApp.getState();
  st.set({ nodes: [...st.nodes, { id: uid('n'), type: 'note', position: { x: pos.x - 110, y: pos.y - 50 }, data: { text: '' } }] });
}

/** Glide the camera to a session, select it, and optionally open its details. */
export function focusSession(rf: Flow, id: string, expand = false) {
  const n = rf.getNode(id);
  if (!n) return;
  const w = n.measured?.width ?? CARD_W;
  const h = n.measured?.height ?? CARD_H;
  const st = useApp.getState();
  st.set({
    expanded: null,
    nodes: st.nodes.map((x) => ((x.id === id) !== !!x.selected ? { ...x, selected: x.id === id } : x)),
  });
  const zoom = Math.min(1.25, Math.max(rf.getZoom(), 1));
  rf.setCenter(n.position.x + w / 2, n.position.y + h / 2, { zoom, duration: 650 });
  if (expand) {
    setTimeout(() => {
      const el = document.querySelector(`.react-flow__node[data-id="${CSS.escape(id)}"]`);
      useApp.getState().set({ expanded: id, expandFrom: el?.getBoundingClientRect() ?? null });
    }, 680);
  }
}

/** Ask the shell (which owns the camera) to focus a session. */
export function requestFocus(id: string, expand = false) {
  window.dispatchEvent(new CustomEvent('sinnect:focus-session', { detail: { id, expand } }));
}
