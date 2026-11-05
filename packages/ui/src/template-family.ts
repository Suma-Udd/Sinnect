// Pure template helpers, kept free of store/engine imports so they can be unit tested.

import type { Family, SessionTemplate } from '@engine/protocol';

/** Template family by id, then by name (families get recreated), else none. Names match case- and space-insensitively. */
export function templateFamily(t: Pick<SessionTemplate, 'familyId' | 'familyName'>, families: Pick<Family, 'id' | 'name'>[]): string | null {
  if (t.familyId && families.some((f) => f.id === t.familyId)) return t.familyId;
  const name = t.familyName?.trim().toLowerCase();
  if (name) {
    const f = families.find((x) => x.name.trim().toLowerCase() === name);
    if (f) return f.id;
  }
  return null;
}

/** Templates pointing at a renamed family, with the new name filled in. Unchanged ones are left out. */
export function renamedFamilyTemplates(templates: SessionTemplate[], familyId: string, name: string): SessionTemplate[] {
  return templates.filter((t) => t.familyId === familyId && t.familyName !== name).map((t) => ({ ...t, familyName: name }));
}
