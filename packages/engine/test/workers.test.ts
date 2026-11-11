import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { classifyTask, isReadOnlyCommand, workerPrompt } from '../src/workers.js';
import { sinnectPrompt } from '../src/session.js';
import type { EngineMsg, SessionConfig, SessionState } from '../src/protocol.js';

test('tasks are routed to a kind without spending tokens', () => {
  assert.equal(classifyTask('Find every file that imports the auth client'), 'search');
  assert.equal(classifyTask('Run the test suite and tell me what fails'), 'test');
  assert.equal(classifyTask('Plan the migration to the new API'), 'plan');
  assert.equal(classifyTask('Review the diff for security problems'), 'review');
  assert.equal(classifyTask('Summarize what src/hub.ts does'), 'read');
  assert.equal(classifyTask('Implement dark mode toggle'), 'code');
  // Jobs that change files need a helper that can edit, even when they also mention tests or finding things.
  assert.equal(classifyTask('Fix the failing test in cart.test.ts'), 'code');
  assert.equal(classifyTask('Find where totals are computed and fix the rounding'), 'code');
  assert.equal(classifyTask('Run the tests, then fix whatever fails'), 'code');
  assert.equal(classifyTask('Write tests for the cart'), 'code');
  // ...but a noun like "the change" doesn't make it a code job.
  assert.equal(classifyTask('Summarize the change in hub.ts'), 'read');
  assert.equal(classifyTask('Write a plan for the auth rewrite'), 'plan');
  assert.equal(classifyTask('Look for bugs in auth.ts'), 'review');
  assert.match(workerPrompt('look around', 'search', 'Lead'), /Only look, do not change any files/);
});

test('look-only helpers can run read-only commands and nothing else', () => {
  for (const ok of ['git diff', 'git log --oneline -5 && git status', 'ls -la | grep foo', 'rg total src 2>&1', 'cd src && grep -rn foo .', 'Get-Content a.txt | Select-String foo']) assert.ok(isReadOnlyCommand(ok), ok);
  for (const no of ['npm test', 'cat a > b', 'echo hi; rm -rf x', 'find . -name x -delete', 'git diff --output=x', 'sed -i s/a/b/ f', 'ls $(rm x)', 'git checkout .', 'sort -o a b'])
    assert.ok(!isReadOnlyCommand(no), no);
});

test('sessions that can spawn are told to use our helpers, not built-in subagents', () => {
  const cfg: SessionConfig = { name: 'Lead', cwd: '/tmp', model: 'claude-opus-5-5', prompt: '', priority: 3, awareness: 'family', permission: 'ask' };
  const on = sinnectPrompt(cfg, '(none)', false, '', true);
  assert.match(on, /spawn_workers/);
  assert.match(on, /instead of the built-in Task\/Agent/);
  assert.match(on, /\[Sinnect helpers\]/);
  assert.doesNotMatch(sinnectPrompt(cfg, '(none)', false, '', false), /spawn_workers/);
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
  const boss: SessionConfig = { name: 'Lead', cwd: '/tmp/shop', model: 'claude-opus-5-5', prompt: 'Split this up with helpers and wait for them: fix checkout totals', priority: 4, awareness: 'family', permission: 'auto' };
  const until = async (fn: () => boolean, ms = 40_000) => {
    for (let t = 0; t < ms && !fn(); t += 50) await new Promise((r) => setTimeout(r, 50));
    return fn();
  };
  const workers = () => [...states.values()].filter((s) => s.config.parentId === 'boss');
  const bossDone = (turns = 1) => (states.get('boss')?.turns ?? 0) >= turns;
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
  assert.ok((boss.workers?.tokens ?? 0) > 0);
  assert.equal(boss.workers?.tokenCap, 1_000_000);
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

test('helpers run in the background by default and report in one message', async () => {
  const t = setup();
  await t.engine.handle({ t: 'session.create', id: 'boss', config: { ...t.boss, prompt: 'Split this up with helpers: fix checkout totals' } });
  // The boss's own turn ends while its helpers are still working, so you can keep talking to it.
  assert.ok(await t.until(() => t.bossDone(1)));
  assert.match(t.spawnResult(), /Started 3 helpers in the background/);
  assert.ok(t.workers().some((w) => w.status !== 'stopped'), 'helpers still working after the boss turn ended');
  assert.equal(t.states.get('boss')?.status, 'idle');
  // Then one report turn once all of them are done.
  assert.ok(await t.until(() => t.bossDone(2)));
  assert.ok(t.workers().every((w) => w.status === 'stopped' && w.summary));
  const feed = t.engine.snapshot().feeds.boss ?? [];
  assert.equal(feed.filter((i) => i.kind === 'system' && /3 helpers reported back/.test(i.text)).length, 1);
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(t.states.get('boss')?.turns, 2, 'exactly one extra turn for the report');
  await t.engine.shutdown();
});

test('the token cap stops helpers too', async () => {
  const t = setup({ workerSpendCapUsd: 0, workerTokenCap: 1000 });
  await t.engine.handle({ t: 'session.create', id: 'boss', config: t.boss });
  assert.ok(await t.until(t.bossDone));
  assert.match(t.spawnResult(), /token cap/);
  assert.ok(t.workers().every((w) => w.status === 'stopped'));
  await t.engine.shutdown();
});

test('helpers asking the exact same thing share one permission card', async () => {
  const opened: string[] = [];
  const t = setup({}, (m, e) => {
    const p = m.prompt;
    if (p.kind === 'tool') opened.push(p.detail ?? '');
    // Answer slowly, so both helpers are asking at the same time.
    setTimeout(() => e.handle({ t: 'prompt.respond', response: p.kind === 'question' ? { requestId: p.requestId, kind: 'question', answers: {}, skipped: true } : { requestId: p.requestId, kind: 'tool', decision: 'allow' } }), 600);
  });
  await t.engine.handle({ t: 'session.create', id: 'boss', config: { ...t.boss, prompt: '', permission: 'ask' } });
  const out = await t.engine.spawnWorkers('boss', [
    { task: 'Run the test suite and report failures', kind: 'test' },
    { task: 'Run the test suite again and list slow tests', kind: 'test' },
  ], { wait: true });
  assert.match(out, /2 helpers finished/);
  assert.equal(opened.filter((d) => d === 'npm test').length, 1, JSON.stringify(opened));
  await t.engine.shutdown();
});

test('finished helpers keep their transcript until the boss goes', async () => {
  const t = setup();
  await t.engine.handle({ t: 'session.create', id: 'boss', config: t.boss });
  assert.ok(await t.until(t.bossDone));
  const ids = t.workers().map((w) => w.id);
  await new Promise((r) => setTimeout(r, 100));
  const snap = t.engine.snapshot();
  for (const id of ids) {
    assert.ok(snap.sessions.some((s) => s.id === id), 'helper still known to the engine');
    assert.ok((snap.feeds[id] ?? []).length > 0, 'helper feed kept');
  }
  await t.engine.handle({ t: 'session.remove', id: 'boss' });
  const after = t.engine.snapshot();
  for (const id of ids) assert.ok(!after.sessions.some((s) => s.id === id), 'removing the boss removes its helpers');
  await t.engine.shutdown();
});

test("a boss can't keep spawning helpers forever without you writing", async () => {
  const t = setup({ maxWorkersPerBoss: 1 });
  await t.engine.handle({ t: 'session.create', id: 'boss', config: { ...t.boss, prompt: '' } });
  const one = [{ task: 'Find the cart total', kind: 'search' as const }];
  for (let i = 0; i < 3; i++) assert.match(await t.engine.spawnWorkers('boss', one, { wait: true }), /1 helper finished/);
  assert.match(await t.engine.spawnWorkers('boss', one, { wait: true }), /already started helpers 3 times/);
  // Writing to the boss gives it fresh rounds.
  await t.engine.handle({ t: 'session.send', id: 'boss', text: 'keep going' });
  assert.match(await t.engine.spawnWorkers('boss', one, { wait: true }), /1 helper finished/);
  await t.engine.shutdown();
});
