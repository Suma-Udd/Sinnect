import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { commitTemplates, loadTemplates, MAX_NAME, MAX_PROMPT, MAX_TEMPLATES, parseTemplates, upsertTemplate } from '../src/templates.js';
import type { EngineMsg, SessionTemplate } from '../src/protocol.js';

const tpl = (o: Partial<SessionTemplate> = {}): SessionTemplate => ({
  id: 't1', name: 'A', model: 'm', priority: 3, awareness: 'everyone', permission: 'ask',
  familyId: null, familyName: null, prompt: 'hi', createdAt: 1, ...o,
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-tpl-'));

function ok(r: ReturnType<typeof upsertTemplate>): SessionTemplate[] {
  assert.ok(r.ok);
  return r.list;
}

test('parse drops bad entries, dup ids, empty names', () => {
  const out = parseTemplates([tpl(), { nope: 1 }, tpl({ id: 't2', name: '  ' }), tpl({ name: 'dup' }), 'x']);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 't1');
});

test('parse non-array gives empty, parse caps count', () => {
  assert.deepEqual(parseTemplates({}), []);
  const many = Array.from({ length: MAX_TEMPLATES + 20 }, (_, i) => tpl({ id: `x${i}` }));
  assert.equal(parseTemplates(many).length, MAX_TEMPLATES);
});

test('upsert adds, overwrites by id, trims name, clamps priority', () => {
  let l = ok(upsertTemplate([], tpl({ name: '  Spaced  ', priority: 99 })));
  assert.equal(l[0].name, 'Spaced');
  assert.equal(l[0].priority, 5);
  l = ok(upsertTemplate(l, tpl({ name: 'B', priority: -4 })));
  assert.equal(l.length, 1);
  assert.equal(l[0].name, 'B');
  assert.equal(l[0].priority, 1);
  l = ok(upsertTemplate(l, tpl({ id: 't2', priority: 2.6 })));
  assert.equal(l.length, 2);
  assert.equal(l[1].priority, 3);
});

test('upsert gives specific errors', () => {
  const blank = upsertTemplate([], tpl({ name: '   ' }));
  assert.ok(!blank.ok && /name/.test(blank.error));
  const bad = upsertTemplate([], { ...tpl(), awareness: 'nope' } as unknown as SessionTemplate);
  assert.ok(!bad.ok && /Invalid/.test(bad.error));
});

test('upsert enforces caps', () => {
  assert.ok(!upsertTemplate([], tpl({ name: 'x'.repeat(MAX_NAME + 1) })).ok);
  assert.ok(!upsertTemplate([], tpl({ prompt: 'x'.repeat(MAX_PROMPT + 1) })).ok);
  assert.ok(upsertTemplate([], tpl({ name: 'x'.repeat(MAX_NAME) })).ok);
  const full = Array.from({ length: MAX_TEMPLATES }, (_, i) => tpl({ id: `x${i}` }));
  assert.ok(!upsertTemplate(full, tpl({ id: 'new' })).ok);
  assert.ok(upsertTemplate(full, tpl({ id: 'x0', name: 'edit' })).ok);
});

const baks = (dir: string) => fs.readdirSync(dir).filter((f) => /^templates\.\d+\.bak$/.test(f));

test('load: missing gives empty; corrupt file is moved to a timestamped backup', () => {
  const dir = tmp();
  assert.deepEqual(loadTemplates(dir), []);
  fs.writeFileSync(path.join(dir, 'templates.json'), '{broken');
  assert.deepEqual(loadTemplates(dir), []);
  assert.ok(!fs.existsSync(path.join(dir, 'templates.json')));
  const [b] = baks(dir);
  assert.equal(fs.readFileSync(path.join(dir, b), 'utf8'), '{broken');
  fs.rmSync(dir, { recursive: true });
});

test('load: second corruption does not overwrite the first backup', async () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'templates.json'), 'one{');
  loadTemplates(dir);
  await new Promise((r) => setTimeout(r, 5));
  fs.writeFileSync(path.join(dir, 'templates.json'), 'two{');
  loadTemplates(dir);
  const contents = baks(dir).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).sort();
  assert.deepEqual(contents, ['one{', 'two{']);
  fs.rmSync(dir, { recursive: true });
});

test('load: lossy file keeps valid entries and gets a backup copy', () => {
  const dir = tmp();
  const text = JSON.stringify([tpl(), { junk: true }]);
  fs.writeFileSync(path.join(dir, 'templates.json'), text);
  assert.equal(loadTemplates(dir).length, 1);
  assert.equal(baks(dir).length, 1);
  assert.equal(fs.readFileSync(path.join(dir, baks(dir)[0]), 'utf8'), text);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'templates.json'), 'utf8')).length, 1);
  // Second launch is clean: same entries, no new backup.
  assert.equal(loadTemplates(dir).length, 1);
  assert.equal(baks(dir).length, 1);
  fs.rmSync(dir, { recursive: true });
});

test('load: clean file makes no backup', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'templates.json'), JSON.stringify([tpl()]));
  assert.equal(loadTemplates(dir).length, 1);
  assert.equal(baks(dir).length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('commit keeps previous list when the write fails', () => {
  const prev = [tpl()];
  const next = [tpl(), tpl({ id: 't2' })];
  const bad = commitTemplates(prev, next, () => {
    throw new Error('disk full');
  });
  assert.equal(bad.list, prev);
  assert.equal(bad.error, 'disk full');
  const good = commitTemplates(prev, next, () => {});
  assert.equal(good.list, next);
  assert.equal(good.error, undefined);
});

function engineAt(dir: string) {
  const sent: EngineMsg[] = [];
  const engine = new Engine({ dataDir: dir, mock: false, broadcast: (m) => sent.push(m) });
  const last = <T extends EngineMsg['t']>(t: T) => sent.findLast((m) => m.t === t) as Extract<EngineMsg, { t: T }> | undefined;
  return { engine, sent, last };
}

test('Engine: save broadcasts, persists, reloads from disk; delete removes', async () => {
  const dir = tmp();
  const a = engineAt(dir);
  await a.engine.handle({ t: 'template.save', template: tpl({ name: ' Hello ' }) });
  assert.equal(a.last('templates')?.templates[0].name, 'Hello');
  assert.equal(a.engine.snapshot().templates.length, 1);
  assert.equal(engineAt(dir).engine.snapshot().templates[0].name, 'Hello');
  await a.engine.handle({ t: 'template.delete', id: 't1' });
  assert.equal(a.last('templates')?.templates.length, 0);
  assert.equal(engineAt(dir).engine.snapshot().templates.length, 0);
  fs.rmSync(dir, { recursive: true });
});

test('Engine: rejected save toasts and resends the real list', async () => {
  const dir = tmp();
  const { engine, sent, last } = engineAt(dir);
  await engine.handle({ t: 'template.save', template: tpl() });
  sent.length = 0;
  await engine.handle({ t: 'template.save', template: tpl({ id: 't2', name: ' ' }) });
  const toast = last('toast');
  assert.equal(toast?.level, 'error');
  assert.match(toast!.text, /name/);
  assert.deepEqual(last('templates')?.templates.map((t) => t.id), ['t1']);
  fs.rmSync(dir, { recursive: true });
});

test('Engine: write failure rolls back memory, toasts, resends list', async () => {
  const dir = tmp();
  const { engine, sent, last } = engineAt(dir);
  await engine.handle({ t: 'template.save', template: tpl() });
  // A directory where the temp file goes makes the next write fail.
  fs.mkdirSync(path.join(dir, 'templates.json.tmp'));
  sent.length = 0;
  await engine.handle({ t: 'template.save', template: tpl({ id: 't2' }) });
  assert.match(last('toast')!.text, /Could not save/);
  assert.deepEqual(last('templates')?.templates.map((t) => t.id), ['t1']);
  assert.equal(engine.snapshot().templates.length, 1);
  sent.length = 0;
  await engine.handle({ t: 'template.delete', id: 't1' });
  assert.equal(engine.snapshot().templates.length, 1);
  assert.equal(last('toast')?.level, 'error');
  fs.rmSync(dir, { recursive: true });
});
