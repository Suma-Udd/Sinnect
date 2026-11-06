import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { classifyTask, workerPrompt } from '../src/workers.js';
import type { EngineMsg, SessionConfig, SessionState } from '../src/protocol.js';

test('tasks are routed to a kind without spending tokens', () => {
  assert.equal(classifyTask('Find every file that imports the auth client'), 'search');
  assert.equal(classifyTask('Run the test suite and tell me what fails'), 'test');
  assert.equal(classifyTask('Plan the migration to the new API'), 'plan');
  assert.equal(classifyTask('Review the diff for security problems'), 'review');
  assert.equal(classifyTask('Summarize what src/hub.ts does'), 'read');
  assert.equal(classifyTask('Implement dark mode toggle'), 'code');
  assert.match(workerPrompt('look around', 'search', 'Lead'), /Only look, do not change any files/);
});

function setup(patch: Record<string, unknown> = {}, onPrompt?: (m: Extract<EngineMsg, { t: 'prompt.open' }>, e: Engine) => void) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-work-'));
  const msgs: EngineMsg[] = [];
  const states = new Map<string, SessionState>();
  const engine: Engine = new Engine({
    dataDir,
    mock: true,
    broadcast: (m) => {
      msgs.push(m);
      if (m.t === 'session.state') states.set(m.state.id, structuredClone(m.state));
      if (m.t === 'prompt.open') {
        if (onPrompt) return onPrompt(m, engine);
        const p = m.prompt;
        setTimeout(
          () => engine.handle({ t: 'prompt.respond', response: p.kind === 'question' ? { requestId: p.requestId, kind: 'question', answers: {}, skipped: true } : { requestId: p.requestId, kind: 'tool', decision: 'allow' } }),
          5,
        );
      }
    },
  });
  engine.handle({ t: 'settings.set', patch: { memoryEnabled: false, ...patch } });
  const boss: SessionConfig = { name: 'Lead', cwd: '/tmp/shop', model: 'claude-opus-5-5', prompt: 'Split this up with helpers: fix checkout totals', priority: 4, awareness: 'family', permission: 'auto' };
  const until = async (fn: () => boolean, ms = 40_000) => {
    for (let t = 0; t < ms && !fn(); t += 50) await new Promise((r) => setTimeout(r, 50));
    return fn();
  };
  const workers = () => [...states.values()].filter((s) => s.config.parentId === 'boss');
  const bossDone = () => (states.get('boss')?.turns ?? 0) >= 1;
  const spawnResult = () => {
    const items = (engine.snapshot().feeds.boss ?? []).filter((i) => i.kind === 'tool_result');
    return items.at(-1)?.text ?? '';
  };
  return { engine, msgs, states, boss, until, workers, bossDone, spawnResult };
}

test('a boss spawns helpers on routed models and gets one summary each', async () => {
  const t = setup();
  await t.engine.handle({ t: 'session.create', id: 'boss', config: t.boss });
  assert.ok(await t.until(t.bossDone), 'boss finished its turn');
  const ws = t.workers();
  assert.equal(ws.length, 3);
  const byKind = Object.fromEntries(ws.map((w) => [w.config.workerKind, w]));
  assert.equal(byKind.search.config.model, 'claude-haiku-5-5');
  assert.equal(byKind.test.config.model, 'claude-haiku-5-5');
  assert.equal(byKind.code.config.model, 'claude-sonnet-5-5');
  for (const w of ws) {
    assert.equal(w.config.awareness, 'solo', 'helpers never message anyone');
    assert.equal(w.config.canSpawn, false, 'no nested spawning by default');
    assert.equal(w.status, 'stopped', 'helpers stop when done');
    assert.ok(w.summary && w.summary.length < 1300);
  }
  const out = t.spawnResult();
  assert.match(out, /3 helpers finished/);
  assert.match(out, /### Search: .*\(Haiku 5\.5\)/);
  const boss = t.states.get('boss')!;
  assert.equal(boss.workers?.total, 3);
  assert.equal(boss.workers?.running, 0);
  assert.ok((boss.workers?.spentUsd ?? 0) > 0);
  // Helpers stay out of other sessions' roster.
  assert.equal(t.engine.hub.visibleTo('boss').length, 0);
  await t.engine.shutdown();
});

test('max helpers per boss is enforced', async () => {
  const t = setup({ maxWorkersPerBoss: 2 });
  await t.engine.handle({ t: 'session.create', id: 'boss', config: t.boss });
  assert.ok(await t.until(t.bossDone));
  assert.equal(t.workers().length, 2);
  assert.match(t.spawnResult(), /1 task\(s\) were not started: max 2 helpers/);
  await t.engine.shutdown();
});

test('the spend cap stops helpers', async () => {
  const t = setup({ workerSpendCapUsd: 0.001 });
  await t.engine.handle({ t: 'session.create', id: 'boss', config: t.boss });
  assert.ok(await t.until(t.bossDone));
  assert.match(t.spawnResult(), /spend cap/);
  assert.ok(t.workers().every((w) => w.status === 'stopped'), JSON.stringify(t.workers().map((w) => [w.status, w.activity, w.costUsd])));
  await t.engine.shutdown();
});

test('ask before spawning: saying no spawns nothing', async () => {
  const t = setup({ askBeforeSpawn: true }, (m, e) => {
    const p = m.prompt;
    const decision = p.kind === 'tool' && p.toolName === 'spawn_workers' ? 'deny' : 'allow';
    setTimeout(() => e.handle({ t: 'prompt.respond', response: p.kind === 'question' ? { requestId: p.requestId, kind: 'question', answers: {}, skipped: true } : { requestId: p.requestId, kind: 'tool', decision } }), 5);
  });
  await t.engine.handle({ t: 'session.create', id: 'boss', config: t.boss });
  assert.ok(await t.until(t.bossDone));
  assert.equal(t.workers().length, 0);
  assert.match(t.spawnResult(), /said no/);
  await t.engine.shutdown();
});

test('sessions with spawning turned off get no helpers', async () => {
  const t = setup();
  await t.engine.handle({ t: 'session.create', id: 'boss', config: { ...t.boss, canSpawn: false } });
  assert.ok(await t.until(t.bossDone));
  assert.equal(t.workers().length, 0);
  await t.engine.shutdown();
});

test('stopping the boss stops running helpers', async () => {
  const t = setup();
  await t.engine.handle({ t: 'session.create', id: 'boss', config: t.boss });
  assert.ok(await t.until(() => t.workers().length === 3));
  await t.engine.handle({ t: 'session.stop', id: 'boss' });
  assert.ok(await t.until(() => t.workers().every((w) => w.status === 'stopped'), 5000));
  await t.engine.shutdown();
});

test('removing a helper twice counts it once on the boss card', async () => {
  const t = setup();
  await t.engine.handle({ t: 'session.create', id: 'boss', config: t.boss });
  assert.ok(await t.until(t.bossDone));
  const ids = t.workers().map((w) => w.id);
  await Promise.all(ids.flatMap((id) => [t.engine.handle({ t: 'session.remove', id }), t.engine.handle({ t: 'session.remove', id })]));
  assert.equal(t.states.get('boss')?.workers?.total, 3);
  await t.engine.shutdown();
});
