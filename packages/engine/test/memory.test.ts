import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MemoryStore, parseNoteFile, parseReflection, projectOf } from '../src/memory.js';
import { Engine } from '../src/engine.js';
import type { EngineMsg } from '../src/protocol.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-mem-'));

test('lessons are plain markdown with frontmatter and read back', () => {
  const dir = tmp();
  const m = new MemoryStore(() => dir);
  const n = m.addLesson({ type: 'rule', title: 'Use npm ci in CI', note: 'The lockfile is checked in.', project: 'shop', source: 'Lead' }, Date.UTC(2026, 10, 6));
  assert.ok(n);
  assert.equal(n.id, 'Lessons/2026-11-06 Use npm ci in CI.md');
  const raw = fs.readFileSync(path.join(dir, n.id), 'utf8');
  assert.match(raw, /^---\ntype: rule\nproject: shop\ntags: \[sinnect-lesson, shop\]/);
  assert.match(raw, /# Use npm ci in CI\n\nThe lockfile is checked in\./);
  const back = m.list()[0];
  assert.equal(back.title, 'Use npm ci in CI');
  assert.equal(back.body, 'The lockfile is checked in.');
  assert.equal(back.project, 'shop');
  assert.equal(back.reviewed, false);
  assert.ok(fs.existsSync(path.join(dir, 'Sinnect Memory.md')), 'index note for Obsidian');
  assert.match(fs.readFileSync(path.join(dir, 'Sinnect Memory.md'), 'utf8'), /\[\[Lessons\/2026-11-06 Use npm ci in CI\|Use npm ci in CI\]\]/);
});

test('near-duplicate lessons are skipped, skills with the same name update', () => {
  const dir = tmp();
  const s = new MemoryStore(() => dir);
  assert.ok(s.addLesson({ type: 'rule', title: 'Run npm ci, never npm install', note: 'x', project: 'p', source: 'a' }));
  assert.equal(s.addLesson({ type: 'rule', title: 'never run npm install, run npm ci', note: 'y', project: 'p', source: 'b' }), null);
  assert.ok(s.addSkill({ name: 'Release', description: 'ship it', steps: '1. old', project: null, source: 'a' }));
  const again = s.addSkill({ name: 'release', description: 'ship it', steps: '1. new', project: null, source: 'b' });
  assert.equal(s.list().filter((n) => n.kind === 'skill').length, 1);
  assert.equal(again?.body, '1. new');
});

test('keep marks reviewed, delete removes, paths outside the folder are refused', () => {
  const dir = tmp();
  const m = new MemoryStore(() => dir);
  const n = m.addLesson({ type: 'broke', title: 'Port 5173 is taken', note: 'Use 5180.', project: null, source: 'a' })!;
  m.keep([n.id]);
  assert.equal(m.list()[0].reviewed, true);
  const outside = path.join(dir, '..', 'victim.md');
  fs.writeFileSync(outside, 'keep me');
  m.remove(['../victim.md', 'Sinnect Memory.md']);
  assert.ok(fs.existsSync(outside));
  assert.ok(fs.existsSync(path.join(dir, 'Sinnect Memory.md')));
  m.remove([n.id]);
  assert.equal(m.list().length, 0);
  fs.unlinkSync(outside);
});

test('a new session only gets notes for its project, under a hard budget', () => {
  const dir = tmp();
  const m = new MemoryStore(() => dir);
  const t = Date.UTC(2026, 0, 1);
  m.addLesson({ type: 'rule', title: 'Shop uses pnpm', note: 'Always pnpm in shop.', project: 'shop', source: 'a' }, t);
  m.addLesson({ type: 'rule', title: 'Blog deploys with Netlify', note: 'Blog only.', project: 'blog', source: 'a' }, t);
  m.addLesson({ type: 'worked', title: 'Prefer small commits everywhere', note: 'Global habit.', project: null, source: 'a' }, t);
  for (let i = 0; i < 40; i++) m.addLesson({ type: 'rule', title: `Shop checkout rule number ${i} zz${i}`, note: 'checkout '.repeat(30), project: 'shop', source: 'a' }, t + i);
  m.addSkill({ name: 'Add checkout step', description: 'adding a step to checkout', steps: '1. a', project: null, source: 'a' });
  const root = path.join(tmp(), 'shop');
  fs.mkdirSync(root);
  const ctx = m.contextFor(root, 'fix the checkout page', { maxNotes: 6 });
  assert.match(ctx, /\[Sinnect memory\]/);
  assert.doesNotMatch(ctx, /Netlify/, 'other projects stay out');
  assert.match(ctx, /Add checkout step/, 'matching skill is listed by name');
  const lessonLines = ctx.split('\n').filter((l) => l.startsWith('- ('));
  assert.ok(lessonLines.length <= 6);
  assert.ok(ctx.length < 2800, `context is ${ctx.length} chars`);
});

test('empty memory still costs only one short line', () => {
  const m = new MemoryStore(tmp);
  const ctx = m.contextFor(tmp(), 'hello', { maxNotes: 6 });
  assert.ok(ctx.length < 300);
  assert.doesNotMatch(ctx, /Notes earlier sessions/);
});

test('projectOf uses the git root folder name', () => {
  const root = path.join(tmp(), 'MyRepo');
  fs.mkdirSync(path.join(root, '.git'), { recursive: true });
  fs.mkdirSync(path.join(root, 'src', 'deep'), { recursive: true });
  assert.equal(projectOf(path.join(root, 'src', 'deep')), 'myrepo');
});

test('reflection parser is forgiving about prose and fences', () => {
  const r = parseReflection('Sure!\n```json\n{"lessons":[{"type":"broke","title":"T","note":"N"},{"type":"weird","title":"T2","note":"N2","everywhere":true},{"title":"","note":"x"}],"skills":[{"name":"S","description":"d","steps":["a","b"]}]}\n```');
  assert.equal(r.lessons.length, 2);
  assert.equal(r.lessons[1].type, 'rule');
  assert.equal(r.lessons[1].everywhere, true);
  assert.equal(r.skills[0].steps, '1. a\n2. b');
  assert.deepEqual(parseReflection('nothing to add'), { lessons: [], skills: [] });
  assert.equal(parseReflection('{"lessons":[{"type":"rule","title":"a","note":"b"}]}').lessons.length, 1);
});

test('frontmatter edited by hand in Obsidian still parses', () => {
  const { meta, body } = parseNoteFile('﻿---\r\ntype: worked\r\ntags: [a, "b c"]\r\nreviewed: true\r\n---\r\n# Hi\r\n\r\nthere');
  assert.equal(meta.type, 'worked');
  assert.deepEqual(meta.tags, ['a', 'b c']);
  assert.equal(meta.reviewed, true);
  assert.match(body, /^# Hi/);
});

test('stopping a demo session that did work writes lessons and announces them', async () => {
  const dataDir = tmp();
  const memDir = path.join(tmp(), 'Vault', 'Sinnect');
  const msgs: EngineMsg[] = [];
  const engine: Engine = new Engine({
    dataDir,
    mock: true,
    broadcast: (m) => {
      msgs.push(m);
      // Nobody is at the keyboard: skip any question the demo session asks.
      if (m.t === 'prompt.open') setTimeout(() => engine.handle({ t: 'prompt.respond', response: { requestId: m.prompt.requestId, kind: 'question', answers: {}, skipped: true } }), 10);
    },
  });
  await engine.handle({ t: 'settings.set', patch: { memoryDir: memDir } });
  const idle = () => msgs.some((m) => m.t === 'session.state' && m.state.id === 's1' && m.state.status === 'idle' && m.state.turns >= 1);
  await engine.handle({ t: 'session.create', id: 's1', config: { name: 'Demo', cwd: '/tmp/shop', model: 'claude-sonnet-5-5', prompt: 'fix login', priority: 3, awareness: 'solo', permission: 'auto' } });
  for (let i = 0; i < 400 && !idle(); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(idle(), 'first turn finished');
  await engine.handle({ t: 'session.stop', id: 's1' });
  const learned = msgs.find((m) => m.t === 'memory.learned');
  assert.ok(learned && learned.t === 'memory.learned' && learned.notes.length >= 2, 'learned popup data');
  assert.ok(fs.readdirSync(path.join(memDir, 'Lessons')).length >= 2, 'notes written into the chosen folder');
  // The next session in the same project gets them in its prompt.
  const ctx = engine.memory.contextFor('/tmp/shop', 'login', { maxNotes: 6 });
  assert.match(ctx, /Notes earlier sessions/);
  await engine.shutdown();
});
