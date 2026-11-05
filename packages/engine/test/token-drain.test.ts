import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulate } from '../sim/token-sim.js';

// Four wired sessions with worst-case polite agents (they answer every message
// and always ask to wake). Before the wake limits this ran ~51 turns off one
// user message, bounced only by the hourly message cap.
test('one user message on a 4-session family stays a handful of turns', async () => {
  const r = await simulate('test');
  assert.ok(r.sum.turns <= 6, `expected <= 6 turns, got ${r.sum.turns}`);
  assert.ok(r.sum.woken <= 5, `expected <= 5 hub wakes, got ${r.sum.woken}`);
});
