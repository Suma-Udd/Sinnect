// Session templates: validation, normalising and persistence. Pure helpers, no engine state.

import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import type { SessionTemplate } from './protocol.js';

const schema = z.object({
  id: z.string().min(1),
  name: z.string(),
  model: z.string(),
  priority: z.number(),
  awareness: z.enum(['solo', 'family', 'everyone']),
  permission: z.enum(['ask', 'acceptEdits', 'auto']),
  familyId: z.string().nullable(),
  familyName: z.string().nullable(),
  prompt: z.string(),
  createdAt: z.number(),
});

/** Trims the name and clamps priority to an integer 1-5. */
export function normalizeTemplate(t: SessionTemplate): SessionTemplate {
  const p = Number.isFinite(t.priority) ? Math.round(t.priority) : 3;
  return { ...t, name: t.name.trim(), priority: Math.min(5, Math.max(1, p)) };
}

/** Parses raw JSON, drops invalid entries, duplicate ids and empty names. */
export function parseTemplates(raw: unknown): SessionTemplate[] {
  if (!Array.isArray(raw)) return [];
  const out: SessionTemplate[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const r = schema.safeParse(item);
    if (!r.success) continue;
    const t = normalizeTemplate(r.data);
    if (!t.name || seen.has(t.id)) continue;
    seen.add(t.id);
    out.push(t);
  }
  return out;
}

/** Insert, or overwrite in place when the id exists. Returns null if the template is unusable. */
export function upsertTemplate(list: SessionTemplate[], incoming: SessionTemplate): SessionTemplate[] | null {
  const parsed = schema.safeParse(incoming);
  if (!parsed.success) return null;
  const t = normalizeTemplate(parsed.data);
  if (!t.name) return null;
  const i = list.findIndex((x) => x.id === t.id);
  if (i < 0) return [...list, t];
  const next = list.slice();
  next[i] = t;
  return next;
}

export function loadTemplates(dataDir: string): SessionTemplate[] {
  try {
    return parseTemplates(JSON.parse(fs.readFileSync(path.join(dataDir, 'templates.json'), 'utf8')));
  } catch {
    return [];
  }
}

/** Atomic write: temp file then rename. */
export function saveTemplates(dataDir: string, list: SessionTemplate[]) {
  const full = path.join(dataDir, 'templates.json');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(full + '.tmp', JSON.stringify(list, null, 2));
  fs.renameSync(full + '.tmp', full);
}

export function demoTemplates(): SessionTemplate[] {
  const now = Date.now();
  return [
    {
      id: 'demo-reviewer',
      name: 'Code reviewer',
      model: 'claude-sonnet-5-5',
      priority: 2,
      awareness: 'everyone',
      permission: 'ask',
      familyId: null,
      familyName: null,
      prompt: 'Review the latest changes for bugs and risky edits. Report short findings, do not edit files.',
      createdAt: now,
    },
    {
      id: 'demo-builder',
      name: 'Backend builder',
      model: 'claude-sonnet-5-5',
      priority: 3,
      awareness: 'family',
      permission: 'acceptEdits',
      familyId: null,
      familyName: 'Backend',
      prompt: 'Implement what Lead asks in this folder. Keep changes small and run the tests.',
      createdAt: now - 1,
    },
  ];
}
