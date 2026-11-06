// Self-learning memory: short lesson notes and reusable skills, saved as plain
// markdown so people can read and edit them (for example in an Obsidian vault).
//
//   <memory folder>/
//     Lessons/<date> <title>.md   one lesson each: what worked, what broke, repo rules
//     Skills/<name>.md            a reusable procedure any session can load by name
//     Sinnect Memory.md           index with [[links]], rewritten on every change
//
// New sessions only get the few notes that match their folder and first
// message (a hard character budget keeps it token-cheap), plus a one-line
// index of matching skills. Full skill text is only loaded when a session
// asks for it with skill_get.

import fs from 'node:fs';
import path from 'node:path';
import type { LessonType, MemoryNote } from './protocol.js';

export const LESSONS = 'Lessons';
export const SKILLS = 'Skills';
const INDEX = 'Sinnect Memory.md';
const MAX_NOTES = 600;
const MAX_TITLE = 90;
const MAX_LESSON = 600;
const MAX_SKILL = 4000;

export interface NewLesson {
  type: LessonType;
  title: string;
  note: string;
  /** null = useful everywhere, otherwise the project (folder name) it belongs to. */
  project: string | null;
  source: string;
  tags?: string[];
}

export interface NewSkill {
  name: string;
  description: string;
  steps: string;
  project: string | null;
  source: string;
  tags?: string[];
}

/** The project a folder belongs to: the git repo's folder name, or the folder's own name. */
export function projectOf(cwd: string): string {
  let dir = path.resolve(cwd);
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.git'))) return path.basename(dir).toLowerCase();
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return path.basename(path.resolve(cwd)).toLowerCase() || 'root';
}

const STOP = new Set(
  'the a an and or but to of in on for with at by from is are was were be been it this that these those i you we they he she as if then so not no yes do does did can could should would will just also into about over than there here what when where which who how why all any some more most other such only own same very use using used make made get got new file files code'.split(
    ' ',
  ),
);

export function words(s: string): string[] {
  return (s.toLowerCase().match(/[a-z0-9][a-z0-9_.-]{1,}/g) ?? []).filter((w) => !STOP.has(w) && w.length > 2);
}

export function slug(s: string, max = 60): string {
  const clean = s
    .replace(/[\\/:*?"<>|#^[\]]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
  return clean || 'note';
}

function oneLine(s: string, n: number) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

// ---------- tiny frontmatter reader/writer (only what we write ourselves) ----------

function yamlValue(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map((x) => yamlValue(x)).join(', ')}]`;
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /^[\w .\-/]+$/.test(s) && !/^(true|false|null|\d)/i.test(s) ? s : JSON.stringify(s);
}

function parseValue(raw: string): unknown {
  const v = raw.trim();
  if (!v) return null;
  if (v.startsWith('[') && v.endsWith(']')) {
    return v
      .slice(1, -1)
      .split(',')
      .map((x) => parseValue(x))
      .filter((x) => x !== null && x !== '');
  }
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('"')) {
    try {
      return JSON.parse(v);
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1);
  return v;
}

export function parseNoteFile(text: string): { meta: Record<string, unknown>; body: string } {
  const src = text.replace(/^﻿/, '');
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { meta: {}, body: src.trim() };
  const meta: Record<string, unknown> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]] = parseValue(kv[2]);
  }
  return { meta, body: src.slice(m[0].length).trim() };
}

function frontmatter(meta: Record<string, unknown>) {
  const lines = Object.entries(meta)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}: ${yamlValue(v)}`);
  return `---\n${lines.join('\n')}\n---\n`;
}

// ---------- the store ----------

export class MemoryStore {
  private cache: MemoryNote[] | null = null;

  constructor(private dir: () => string) {}

  get root() {
    return this.dir();
  }

  /** Forget the cache, for when someone edits the folder by hand. */
  refresh() {
    this.cache = null;
  }

  list(): MemoryNote[] {
    if (this.cache) return this.cache;
    const out: MemoryNote[] = [];
    for (const [sub, kind] of [
      [LESSONS, 'lesson'],
      [SKILLS, 'skill'],
    ] as const) {
      const folder = path.join(this.root, sub);
      let files: string[] = [];
      try {
        files = fs.readdirSync(folder).filter((f) => f.toLowerCase().endsWith('.md'));
      } catch {
        continue;
      }
      for (const f of files.slice(0, MAX_NOTES)) {
        const id = `${sub}/${f}`;
        try {
          const raw = fs.readFileSync(path.join(folder, f), 'utf8');
          out.push(this.fromFile(id, kind, raw, fs.statSync(path.join(folder, f)).mtimeMs));
        } catch {
          /* unreadable file, skip it */
        }
      }
    }
    out.sort((a, b) => b.createdAt - a.createdAt);
    this.cache = out;
    return out;
  }

  private fromFile(id: string, kind: 'lesson' | 'skill', raw: string, mtime: number): MemoryNote {
    const { meta, body } = parseNoteFile(raw);
    // The first "# heading" is the title; everything after it is the note.
    const h = /^#\s+(.+)\r?\n?/.exec(body);
    const fileTitle = path.basename(id, '.md').replace(/^\d{4}-\d{2}-\d{2}\s+/, '');
    const title = String(meta.title ?? meta.name ?? h?.[1] ?? fileTitle).trim();
    const text = (h ? body.slice(h[0].length) : body).trim();
    const created = Date.parse(String(meta.created ?? '')) || mtime;
    const tags = Array.isArray(meta.tags) ? meta.tags.map(String).filter((t) => t !== 'sinnect' && t !== 'sinnect-lesson' && t !== 'sinnect-skill') : [];
    const type = String(meta.type ?? '');
    return {
      id,
      kind,
      title,
      body: text,
      description: kind === 'skill' ? String(meta.description ?? '').trim() || oneLine(text, 140) : undefined,
      type: kind === 'lesson' ? ((['rule', 'worked', 'broke'].includes(type) ? type : 'rule') as LessonType) : undefined,
      project: meta.project ? String(meta.project).toLowerCase() : null,
      tags,
      source: String(meta.source ?? ''),
      createdAt: created,
      reviewed: meta.reviewed !== false,
    };
  }

  private write(id: string, content: string) {
    const full = path.join(this.root, id);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full + '.tmp', content);
    fs.renameSync(full + '.tmp', full);
  }

  private uniqueId(sub: string, base: string) {
    let id = `${sub}/${base}.md`;
    for (let i = 2; fs.existsSync(path.join(this.root, id)); i++) id = `${sub}/${base} ${i}.md`;
    return id;
  }

  /** Close enough to an existing note (same words in the title, same scope) that saving it would just be noise. */
  private duplicate(kind: 'lesson' | 'skill', title: string, project: string | null): MemoryNote | undefined {
    const a = new Set(words(title));
    return this.list().find((n) => {
      if (n.kind !== kind) return false;
      if (kind === 'skill') return n.title.toLowerCase() === title.toLowerCase();
      if ((n.project ?? null) !== project && n.project !== null) return false;
      const b = new Set(words(n.title));
      if (!a.size || !b.size) return n.title.toLowerCase() === title.toLowerCase();
      let same = 0;
      for (const w of a) if (b.has(w)) same++;
      return same / Math.max(a.size, b.size) >= 0.75;
    });
  }

  addLesson(l: NewLesson, now = Date.now()): MemoryNote | null {
    const title = oneLine(l.title, MAX_TITLE);
    const note = String(l.note ?? '').trim().slice(0, MAX_LESSON);
    if (!title || !note) return null;
    if (this.duplicate('lesson', title, l.project)) return null;
    const date = new Date(now).toISOString().slice(0, 10);
    const id = this.uniqueId(LESSONS, `${date} ${slug(title)}`);
    const tags = ['sinnect-lesson', ...(l.project ? [l.project] : []), ...(l.tags ?? []).map((t) => slug(t, 30).replace(/\s+/g, '-').toLowerCase())];
    const meta = {
      type: l.type,
      project: l.project ?? undefined,
      tags: [...new Set(tags)],
      source: l.source,
      created: new Date(now).toISOString(),
      reviewed: false,
    };
    this.write(id, `${frontmatter(meta)}# ${title}\n\n${note}\n`);
    this.cache = null;
    this.writeIndex();
    return this.list().find((n) => n.id === id) ?? null;
  }

  addSkill(s: NewSkill, now = Date.now()): MemoryNote | null {
    const name = oneLine(s.name, 60);
    const steps = String(s.steps ?? '').trim().slice(0, MAX_SKILL);
    if (!name || !steps) return null;
    const existing = this.duplicate('skill', name, s.project);
    // Saving a skill with the same name again updates it: the newest steps win.
    const id = existing?.id ?? this.uniqueId(SKILLS, slug(name));
    const meta = {
      name,
      description: oneLine(s.description, 200),
      project: s.project ?? undefined,
      tags: [...new Set(['sinnect-skill', ...(s.project ? [s.project] : []), ...(s.tags ?? [])])],
      source: s.source,
      created: new Date(existing?.createdAt ?? now).toISOString(),
      reviewed: false,
    };
    this.write(id, `${frontmatter(meta)}# ${name}\n\n${steps}\n`);
    this.cache = null;
    this.writeIndex();
    return this.list().find((n) => n.id === id) ?? null;
  }

  private safe(id: string): string | null {
    const full = path.resolve(this.root, id);
    const rel = path.relative(path.resolve(this.root), full);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !/\.md$/i.test(rel)) return null;
    if (!rel.startsWith(LESSONS + path.sep) && !rel.startsWith(SKILLS + path.sep)) return null;
    return full;
  }

  remove(ids: string[]) {
    let n = 0;
    for (const id of ids) {
      const full = this.safe(id);
      if (!full) continue;
      try {
        fs.unlinkSync(full);
        n++;
      } catch {
        /* already gone */
      }
    }
    this.cache = null;
    if (n) this.writeIndex();
    return n;
  }

  /** "Keep": flip reviewed to true in the note's frontmatter. */
  keep(ids: string[]) {
    for (const id of ids) {
      const full = this.safe(id);
      if (!full) continue;
      try {
        const raw = fs.readFileSync(full, 'utf8');
        const next = raw.replace(/^(---[\s\S]*?\n)reviewed:\s*false(\s*\n)/, '$1reviewed: true$2');
        if (next !== raw) fs.writeFileSync(full, next);
      } catch {
        /* gone */
      }
    }
    this.cache = null;
  }

  getSkill(name: string, project: string | null): MemoryNote | null {
    const want = name.trim().toLowerCase();
    const skills = this.list().filter((n) => n.kind === 'skill' && (n.project === null || n.project === project || project === null));
    return (
      skills.find((n) => n.title.toLowerCase() === want) ??
      skills.find((n) => slug(n.title).toLowerCase() === slug(name).toLowerCase()) ??
      skills.find((n) => n.title.toLowerCase().includes(want)) ??
      null
    );
  }

  /** Lessons and skills ranked for a session: same project first, then word overlap with what it's doing. */
  ranked(project: string | null, text: string): MemoryNote[] {
    const q = new Set(words(text));
    const score = (n: MemoryNote) => {
      if (n.project && project && n.project !== project) return -1;
      let s = n.project && n.project === project ? 3 : n.project ? 0 : 1;
      const hay = new Set(words(`${n.title} ${n.description ?? ''} ${n.tags.join(' ')} ${n.body.slice(0, 400)}`));
      for (const w of q) if (hay.has(w)) s += 1.5;
      if (n.type === 'rule') s += 0.5;
      if (n.type === 'broke') s += 0.25;
      // Newer notes win ties.
      return s + Math.min(0.4, n.createdAt / 1e14);
    };
    return this.list()
      .map((n) => ({ n, s: score(n) }))
      .filter((x) => x.s >= 1)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.n);
  }

  /**
   * The memory block that goes into a new session's system prompt.
   * Hard capped by characters so a big memory folder never makes sessions expensive.
   */
  contextFor(cwd: string, prompt: string, opts: { maxNotes: number; maxChars?: number }): string {
    const project = projectOf(cwd);
    const all = this.ranked(project, `${project} ${prompt}`);
    const lessons = all.filter((n) => n.kind === 'lesson').slice(0, Math.max(0, opts.maxNotes));
    const skills = all.filter((n) => n.kind === 'skill').slice(0, 8);
    const budget = opts.maxChars ?? 1800;
    const lines: string[] = [];
    let used = 0;
    for (const l of lessons) {
      const line = `- (${l.type}) ${l.title}: ${oneLine(l.body, 260)}`;
      if (used + line.length > budget) break;
      lines.push(line);
      used += line.length;
    }
    const skillLine = skills.length ? `Saved skills (load the steps with skill_get): ${skills.map((s) => `${s.title} (${oneLine(s.description ?? '', 70)})`).join('; ')}` : '';
    const out = [
      lines.length ? `[Sinnect memory] Notes earlier sessions left about this work. Trust them, but check if something looks outdated:\n${lines.join('\n')}` : '',
      skillLine,
      `If you learn something non-obvious a future session here should know (a repo rule, a command that works, a trap), save it with memory_save. Save a multi-step procedure you expect to repeat with skill_save. Don't save task summaries.`,
    ].filter(Boolean);
    return out.join('\n');
  }

  /** An Obsidian-friendly index note, so the vault shows everything in one place. */
  writeIndex() {
    try {
      const notes = this.list();
      const link = (n: MemoryNote) => `[[${n.id.replace(/\.md$/i, '')}|${n.title}]]`;
      const byProject = new Map<string, MemoryNote[]>();
      for (const n of notes.filter((x) => x.kind === 'lesson')) {
        const k = n.project ?? 'Everywhere';
        byProject.set(k, [...(byProject.get(k) ?? []), n]);
      }
      const parts = [
        `---\ntags: [sinnect]\n---\n# Sinnect Memory\n`,
        `What your Sinnect sessions learned. Edit or delete any note, Sinnect reads this folder fresh. This index is rewritten automatically.\n`,
        `## Skills\n${notes.filter((n) => n.kind === 'skill').map((n) => `- ${link(n)}: ${n.description ?? ''}`).join('\n') || '_None yet._'}\n`,
        `## Lessons`,
        ...[...byProject.entries()].map(([p, list]) => `### ${p}\n${list.map((n) => `- ${link(n)} (${n.type})`).join('\n')}\n`),
      ];
      if (byProject.size === 0) parts.push('_None yet._');
      fs.mkdirSync(this.root, { recursive: true });
      fs.writeFileSync(path.join(this.root, INDEX), parts.join('\n') + '\n');
    } catch {
      /* the index is a nice-to-have */
    }
  }
}

// ---------- reflection ----------

/** What a session is asked when it ends. Short on purpose: it rides on the cached conversation. */
export const REFLECT_PROMPT = [
  '[Sinnect memory] This session is wrapping up. Write down what a future session working here should know: rules of this repo (commands, conventions), things that worked, things that broke and why.',
  'Only non-obvious facts that will still be true next time. No task summary, nothing already in your [Sinnect memory] notes. If you ran a multi-step procedure that will clearly be repeated, save it as a skill.',
  'Do not use any tools. Reply with only this JSON block, at most 4 lessons and 1 skill, empty lists are fine:',
  '```json',
  '{"lessons":[{"type":"rule|worked|broke","title":"max 8 words","note":"one or two sentences","everywhere":false}],"skills":[{"name":"short name","description":"when to use it, one line","steps":"1. ...\\n2. ..."}]}',
  '```',
].join('\n');

export interface Reflection {
  lessons: { type: LessonType; title: string; note: string; everywhere: boolean }[];
  skills: { name: string; description: string; steps: string }[];
}

/** Pull the JSON block out of a reply. Forgiving: models wrap it in prose or forget the fence. */
export function parseReflection(text: string): Reflection {
  const empty: Reflection = { lessons: [], skills: [] };
  const fenced = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = fenced.length ? fenced.reverse() : [];
  const brace = text.indexOf('{');
  if (brace >= 0) candidates.push(text.slice(brace, text.lastIndexOf('}') + 1));
  for (const c of candidates) {
    let data: unknown;
    try {
      data = JSON.parse(c.trim());
    } catch {
      continue;
    }
    if (!data || typeof data !== 'object') continue;
    const d = data as { lessons?: unknown; skills?: unknown };
    const lessons = (Array.isArray(d.lessons) ? d.lessons : [])
      .map((l: any) => ({
        type: (['rule', 'worked', 'broke'].includes(l?.type) ? l.type : 'rule') as LessonType,
        title: String(l?.title ?? '').trim(),
        note: String(l?.note ?? l?.text ?? '').trim(),
        everywhere: l?.everywhere === true,
      }))
      .filter((l) => l.title && l.note)
      .slice(0, 4);
    const skills = (Array.isArray(d.skills) ? d.skills : [])
      .map((s: any) => ({
        name: String(s?.name ?? '').trim(),
        description: String(s?.description ?? '').trim(),
        steps: Array.isArray(s?.steps) ? s.steps.map((x: unknown, i: number) => `${i + 1}. ${x}`).join('\n') : String(s?.steps ?? '').trim(),
      }))
      .filter((s) => s.name && s.steps)
      .slice(0, 1);
    return { lessons, skills };
  }
  return empty;
}
