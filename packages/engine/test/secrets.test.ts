import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';

// Windows has no owner-only file mode to check.
const skip = process.platform === 'win32';

const setup = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-secrets-'));
  return { dir, file: path.join(dir, 'secrets.json') };
};
const start = (dir: string) => new Engine({ dataDir: dir, mock: true, broadcast: () => {} });
const modeOf = (file: string) => fs.statSync(file).mode & 0o777;

test('saving a key writes secrets.json for the owner only', { skip }, async () => {
  const { dir, file } = setup();
  const engine = start(dir);
  await engine.handle({ t: 'settings.set', patch: { apiKey: 'test-key' } });
  assert.equal(modeOf(file), 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).apiKey, 'test-key');
  await engine.shutdown();
});

test('starting up tightens a secrets.json from an older version and keeps its keys', { skip }, async () => {
  const { dir, file } = setup();
  fs.writeFileSync(file, JSON.stringify({ apiKey: 'old-key' }), { mode: 0o644 });
  fs.chmodSync(file, 0o644);
  const engine = start(dir);
  assert.equal(modeOf(file), 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).apiKey, 'old-key');
  await engine.shutdown();
});

test('a .tmp left by a crash does not pass its mode on to secrets.json', { skip }, async () => {
  const { dir, file } = setup();
  fs.writeFileSync(file + '.tmp', 'partial', { mode: 0o644 });
  fs.chmodSync(file + '.tmp', 0o644);
  const engine = start(dir);
  await engine.handle({ t: 'settings.set', patch: { apiKey: 'test-key' } });
  assert.equal(modeOf(file), 0o600);
  assert.equal(fs.existsSync(file + '.tmp'), false);
  await engine.shutdown();
});

test('starting up without a secrets.json does not create one', { skip }, async () => {
  const { dir, file } = setup();
  const engine = start(dir);
  assert.equal(fs.existsSync(file), false);
  await engine.shutdown();
});

test('an OpenAI key is saved next to the others and reported in settings', { skip }, async () => {
  const { dir, file } = setup();
  const sent: any[] = [];
  const engine = new Engine({ dataDir: dir, mock: true, broadcast: (m: any) => sent.push(m) });
  await engine.handle({ t: 'settings.set', patch: { openaiKey: ' sk-test ' } });
  assert.equal(modeOf(file), 0o600);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).openaiKey, 'sk-test');
  assert.equal(sent.findLast((m) => m.t === 'settings').settings.hasOpenaiKey, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).hasOpenaiKey, undefined, 'key state is not persisted as a setting');
  await engine.shutdown();
});
