// Token drain simulator for Gemini sessions. Runs the real Engine, Hub and
// GeminiSession against a fake Gemini server (sim/fake-gemini.ts), so the whole
// Gemini code path is exercised without a key or any cost.
// Run: npx tsx sim/gemini-sim.ts
//
// The fake models are worst case on purpose: they answer every hub message
// with "thanks / noted" and always ask to wake the other side.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import type { EngineMsg, SessionConfig } from '../src/protocol.js';
import { call, hubLines, rosterIds, say, startFakeGemini, stepInTurn, userText, type Policy } from './fake-gemini.js';

export interface SimResult {
  label: string;
  rows: { session: string; turns: number; requests: number; promptTokens: number; cachedTokens: number }[];
  sum: { turns: number; requests: number; promptTokens: number; cachedTokens: number; hubWakes: number; hubMessages: number };
}

/** Everyone thanks everyone, always with wake=true. The Lead sends the task out on the user's message. */
export function politePolicy(opts: { leadSteps?: number } = {}): Policy {
  const leadSteps = opts.leadSteps ?? 1;
  return (req, session) => {
    const step = stepInTurn(req);
    const replies = hubLines(req)
      .filter((l) => l.from !== 'hub')
      .map((l) => call('hub_send', { to: l.from, message: /please/i.test(l.text) ? 'Done with my part.' : 'Thanks, noted!', wake: true }));
    if (session === 'Lead' && userText(req) && step === 0) {
      return [...replies, ...rosterIds(req).map((id) => call('hub_send', { to: id, message: 'Please build your part of session templates.', wake: true }))];
    }
    // The Lead keeps working on a long turn, so replies land in its tool results.
    if (session === 'Lead' && step < leadSteps) return [...replies, call('read_file', { path: 'README.md' })];
    if (replies.length) return replies;
    return [say('Ok.')];
  };
}

/** Two sessions working side by side on long turns, no messages at all. Shows prompt caching. */
export function busyPolicy(steps = 10): Policy {
  return (req) => (stepInTurn(req) < steps ? [call('read_file', { path: 'README.md' })] : [say('Done.')]);
}

export async function simulate(label: string, policy: Policy, opts: { latencyMs?: number; sessions?: string[]; starters?: string[]; maxWakeChain?: number; maxWakesPerHour?: number } = {}): Promise<SimResult> {
  const names = opts.sessions ?? ['Lead', 'UI', 'Engine', 'Reviewer'];
  const fake = await startFakeGemini(policy, { latencyMs: opts.latencyMs ?? 50 });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-gsim-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n'.repeat(40));
  process.env.GEMINI_API_KEY = 'fake-key';
  const msgs: EngineMsg[] = [];
  const engine = new Engine({ dataDir: path.join(dir, '.data'), mock: false, broadcast: (m) => msgs.push(m) });
  const patch: Record<string, unknown> = { memoryEnabled: false };
  if (opts.maxWakeChain !== undefined) patch.maxWakeChain = opts.maxWakeChain;
  if (opts.maxWakesPerHour !== undefined) patch.maxWakesPerHour = opts.maxWakesPerHour;
  await engine.handle({ t: 'settings.set', patch } as never);
  const ids: Record<string, string> = {};
  for (const name of names) {
    const id = name.toLowerCase();
    ids[name] = id;
    const cfg: SessionConfig = { name, cwd: dir, model: 'gemini-2.5-flash', prompt: '', priority: 3, awareness: 'family', permission: 'auto', familyId: 'fam' };
    await engine.handle({ t: 'session.create', id, config: cfg });
  }
  for (const name of opts.starters ?? ['Lead']) await engine.handle({ t: 'session.send', id: ids[name], text: 'Build session templates with the team.' } as never);

  // Run until nothing happened for 3 seconds (wakes are batched for 1.5s), max 60s.
  const total = () => [...fake.stats.values()].reduce((a, s) => a + s.requests, 0);
  let last = -1;
  let quietSince = Date.now();
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    await new Promise((r) => setTimeout(r, 200));
    const n = total();
    if (n !== last) {
      last = n;
      quietSince = Date.now();
    } else if (Date.now() - quietSince > 3000) break;
  }

  const states = new Map<string, number>();
  for (const m of msgs) if (m.t === 'session.state') states.set(m.state.id, m.state.turns);
  const rows = names.map((name) => {
    const s = fake.stats.get(name) ?? { requests: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0 };
    return { session: name, turns: states.get(ids[name]) ?? 0, requests: s.requests, promptTokens: s.promptTokens, cachedTokens: s.cachedTokens };
  });
  const log = msgs.filter((m) => m.t === 'hub.message').map((m) => (m as { message: { kind: string; woke?: boolean } }).message);
  if (process.env.SIM_LOG) for (const m of msgs) if (m.t === 'hub.message') console.log((m as any).message.from, '->', (m as any).message.to, (m as any).message.depth, (m as any).message.woke, (m as any).message.text);
  const sum = {
    turns: rows.reduce((a, r) => a + r.turns, 0),
    requests: rows.reduce((a, r) => a + r.requests, 0),
    promptTokens: rows.reduce((a, r) => a + r.promptTokens, 0),
    cachedTokens: rows.reduce((a, r) => a + r.cachedTokens, 0),
    hubMessages: log.filter((m) => m.kind === 'message').length,
    hubWakes: log.filter((m) => m.kind === 'message' && m.woke).length,
  };
  await engine.shutdown();
  await fake.close();
  return { label, rows, sum };
}

if (process.argv[1]?.endsWith('gemini-sim.ts')) {
  for (const [label, policy, ...rest] of [
    ['short turns (Lead sends and stops)', politePolicy()],
    ['long Lead turn (replies land mid-turn)', politePolicy({ leadSteps: 15 })],
    ['two busy sessions, no messages (caching)', busyPolicy(), { sessions: ['Lead', 'UI'], starters: ['Lead', 'UI'] }],
  ] as const) {
    const r = await simulate(label, policy, { latencyMs: 400, ...((rest as unknown as [object])[0] ?? {}) });
    console.log(`\n== ${label}`);
    console.table(r.rows);
    console.log({ ...r.sum, cachedPct: Math.round((100 * r.sum.cachedTokens) / Math.max(1, r.sum.promptTokens)) + '%' });
  }
}
