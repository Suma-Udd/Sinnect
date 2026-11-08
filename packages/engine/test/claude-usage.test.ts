import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeUsageFrom } from '../src/claude-usage.js';

test('Claude /usage answers become 5-hour and weekly windows', () => {
  const r = claudeUsageFrom({ rate_limits_available: true, subscription_type: 'max', rate_limits: { five_hour: { utilization: 36, resets_at: '2026-11-09T01:00:00Z' }, seven_day: { utilization: 100, resets_at: null } } });
  assert.deepEqual(r, {
    plan: 'max',
    usage: { primary: { usedPercent: 36, windowMins: 300, resetsAt: Date.parse('2026-11-09T01:00:00Z') / 1000 }, secondary: { usedPercent: 100, windowMins: 10_080, resetsAt: null }, reached: true },
  });
  assert.equal(claudeUsageFrom({ rate_limits_available: false, rate_limits: null }), null, 'API key logins have no plan limits');
  assert.equal(claudeUsageFrom({ rate_limits_available: true, rate_limits: { five_hour: null } }), null);
});
