import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadTemplates, parseTemplates, saveTemplates, upsertTemplate } from '../src/templates.js';
import type { SessionTemplate } from '../src/protocol.js';

const tpl = (o: Partial<SessionTemplate> = {}): SessionTemplate => ({
  id: 't1', name: 'A', model: 'm', priority: 3, awareness: 'everyone', permission: 'ask',
  familyId: null, familyName: null, prompt: 'hi', createdAt: 1, ...o,
});

test('parse drops bad entries, dup ids, empty names', () => {
  const out = parseTemplates([tpl(), { nope: 1 }, tpl({ id: 't2', name: '  ' }), tpl({ name: 'dup' }), 'x']);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, 't1');
});

test('parse non-array gives empty', () => {
  assert.deepEqual(parseTemplates({}), []);
});

test('upsert adds, overwrites by id, trims name, clamps priority', () => {
  let l = upsertTemplate([], tpl({ name: '  Spaced  ', priority: 99 }))!;
  assert.equal(l[0].name, 'Spaced');
  assert.equal(l[0].priority, 5);
  l = upsertTemplate(l, tpl({ name: 'B', priority: -4 }))!;
  assert.equal(l.length, 1);
  assert.equal(l[0].name, 'B');
  assert.equal(l[0].priority, 1);
  l = upsertTemplate(l, tpl({ id: 't2', priority: 2.6 }))!;
  assert.equal(l.length, 2);
  assert.equal(l[1].priority, 3);
});

test('upsert rejects empty name', () => {
  assert.equal(upsertTemplate([], tpl({ name: '   ' })), null);
});

test('save/load roundtrip, atomic, missing or corrupt file gives empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-tpl-'));
  assert.deepEqual(loadTemplates(dir), []);
  saveTemplates(dir, [tpl()]);
  assert.equal(loadTemplates(dir).length, 1);
  assert.ok(!fs.existsSync(path.join(dir, 'templates.json.tmp')));
  fs.writeFileSync(path.join(dir, 'templates.json'), '{broken');
  assert.deepEqual(loadTemplates(dir), []);
  fs.rmSync(dir, { recursive: true });
});
