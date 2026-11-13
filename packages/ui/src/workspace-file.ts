// Pure workspace helpers, kept free of store/engine imports so they can be unit tested.

import { safeName } from '@engine/protocol';

/** The board's name is kept as typed, but the list shows the file name, so compare through safeName. */
export const isOpenWorkspace = (listed: string, current: string) => safeName(current) === listed;

/**
 * True when the open board has a saved file of its own (not the hidden __autosave).
 * Autosave only writes __autosave, so leaving such a board must save it there first.
 */
export function hasOwnFile(current: string, saved: { name: string }[]): boolean {
  return !current.startsWith('__') && saved.some((w) => isOpenWorkspace(w.name, current));
}
