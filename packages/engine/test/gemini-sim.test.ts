import { test } from 'node:test';
import assert from 'node:assert/strict';
import { busyPolicy, politePolicy, simulate } from '../sim/gemini-sim.js';
import { runMemory } from '../sim/gemini-memory-sim.js';
import { geminiPrice } from '../src/gemini-session.js';

// All of these run the real Engine + GeminiSession against the fake Gemini
// server in sim/fake-gemini.ts. No key, no network.

test('gemini: one user message on a 4-session family stays a handful of turns', async () => {
  const r = await simulate('short', politePolicy());
  assert.ok(r.sum.turns <= 6, `expected <= 6 turns, got ${r.sum.turns}`);
  assert.ok(r.sum.hubWakes <= 6, `expected <= 6 wakes, got ${r.sum.hubWakes}`);
});

// Replies that land in the middle of a long turn used to be answered at wake
// depth 1 again, so the chain limit never kicked in (11 turns, 17 wakes here).
test('gemini: replies read mid-turn still count toward the wake chain', async () => {
  const r = await simulate('long', politePolicy({ leadSteps: 25 }), { latencyMs: 300 });
  assert.ok(r.sum.turns <= 6, `expected <= 6 turns, got ${r.sum.turns}`);
  assert.ok(r.sum.hubWakes <= 6, `expected <= 6 wakes, got ${r.sum.hubWakes}`);
});

test('gemini: the system prompt stays the same so implicit caching works', async () => {
  const r = await simulate('busy', busyPolicy(8), { sessions: ['Lead', 'UI'], starters: ['Lead', 'UI'], latencyMs: 100 });
  const pct = r.sum.cachedTokens / r.sum.promptTokens;
  assert.ok(pct > 0.85, `expected > 85% cached, got ${Math.round(pct * 100)}%`);
});

test('gemini: sessions get a cost estimate so budgets and helper caps apply', () => {
  assert.deepEqual(geminiPrice('gemini-flash-latest'), { input: 0.3, output: 2.5 });
  assert.deepEqual(geminiPrice('gemini-flash-lite-latest'), { input: 0.1, output: 0.4 });
  assert.deepEqual(geminiPrice('gemini-2.5-pro'), { input: 1.25, output: 10 });
});

for (const vault of [false, true]) {
  test(`gemini memory ${vault ? 'in an Obsidian vault' : 'in the default folder'}: save, reflect, reuse, helpers`, async () => {
    const r = await runMemory({ vault });
    if (vault) assert.match(r.memoryPath, /Agent Obsidian[\\/]Sinnect$/);
    assert.ok(r.files.includes('Skills/Ship a Sinnect release.md'), 'skill_save wrote a skill note');
    assert.ok(r.files.some((f) => f.endsWith('Use npm test for engine tests.md')), 'memory_save wrote a lesson');
    assert.ok(r.files.some((f) => f.endsWith('Engine tests need tsx loader.md')), 'stopping wrote the reflection lesson');
    assert.match(r.index, /\[\[Skills\/Ship a Sinnect release\|/, 'index links notes for Obsidian');
    const reader = r.seen.Reader;
    assert.ok(reader.system.includes('Use npm test for engine tests'), 'next session gets the lesson in its prompt');
    assert.ok(reader.system.includes('Ship a Sinnect release'), 'and the skill in its skill list');
    assert.ok(reader.results.some((x) => x.startsWith('skill_get') && x.includes('Build and release')), 'skill_get returns the steps');
    assert.ok(reader.results.some((x) => x.startsWith('memory_search') && x.includes('tsx loader')), 'memory_search finds lessons');
    assert.ok(r.seen.Boss.results.some((x) => x.startsWith('spawn_workers') && x.includes('wakeBlocker')), 'Gemini boss got its helper summary');
    assert.ok(r.costUsd.Learner > 0, 'Gemini sessions show a cost');
  });
}

test('gemini memory turned off: no memory tools, nothing written', async () => {
  const r = await runMemory({ vault: false, memoryOn: false });
  assert.ok(!r.seen.Reader.tools.some((t) => t.startsWith('memory_') || t.startsWith('skill_')));
  assert.deepEqual(r.files, []);
});
