import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Engine } from '../src/engine.js';
import { net } from '../src/loop-session.js';
import type { EngineMsg, SessionConfig } from '../src/protocol.js';

// Token drain check for OpenAI sessions, like the Gemini sims: the real Engine,
// Hub and OpenAISession against a fake Responses API. The fake models are worst
// case on purpose: they thank everyone for every hub message and always ask to
// wake the other side. The guardrails (wake chain, wake rate, batching) must
// keep that to a handful of turns.

type Req = { instructions: string; input: any[]; prompt_cache_key?: string };

const msgsIn = (req: Req) => {
  // Everything since the last assistant step is what's new for this request.
  let i = req.input.length - 1;
  while (i >= 0 && req.input[i].type !== 'function_call' && !(req.input[i].type === 'message' && req.input[i].role === 'assistant')) i--;
  return req.input.slice(i + 1);
};
const stepInTurn = (req: Req) => {
  let n = 0;
  for (let i = req.input.length - 1; i >= 0; i--) {
    const it = req.input[i];
    if (it.type === 'function_call') n++;
    else if (it.type === 'message' && it.role === 'user' && !String(it.content).startsWith('[Sinnect hub]')) break;
  }
  return n;
};

function sse(items: any[], usage: object) {
  const ev = (e: any) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
  const body = items.map((item) => ev({ type: 'response.output_item.done', item })).join('') + ev({ type: 'response.completed', response: { usage } });
  return new Response(new Blob([body]).stream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

async function simulate(opts: { leadSteps: number; latencyMs: number }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-osim-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# demo\n'.repeat(40));
  process.env.OPENAI_API_KEY = 'fake';
  const requests: Record<string, number> = {};
  let seq = 0;
  const real = net.fetch;
  net.fetch = async (_url, init) => {
    const req = JSON.parse(String(init?.body)) as Req;
    const me = /You are "([^"]+)"/.exec(req.instructions)?.[1] ?? '?';
    requests[me] = (requests[me] ?? 0) + 1;
    await new Promise((r) => setTimeout(r, opts.latencyMs));
    const fresh = msgsIn(req).map((i) => (i.type === 'function_call_output' ? i.output : String(i.content ?? ''))).join('\n');
    const call = (name: string, args: object) => ({ type: 'function_call', call_id: `c${++seq}`, name, arguments: JSON.stringify(args) });
    const replies = [...fresh.matchAll(/- from [^(\n]+\((\w+)\): (.*)/g)].map((m) => call('hub_send', { to: m[1], message: /please/i.test(m[2]) ? 'Done with my part.' : 'Thanks, noted!', wake: true }));
    const step = stepInTurn(req);
    let items: any[];
    if (me === 'Lead' && step === 0 && /Build session templates/.test(fresh)) {
      const ids = [...req.instructions.matchAll(/\(id (\w+),/g)].map((m) => m[1]);
      items = [...replies, ...ids.map((id) => call('hub_send', { to: id, message: 'Please build your part.', wake: true }))];
    } else if (me === 'Lead' && step < opts.leadSteps) items = [...replies, call('read_file', { path: 'README.md' })];
    else if (replies.length) items = replies;
    else items = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Ok.' }] }];
    return sse(items, { input_tokens: 3000, input_tokens_details: { cached_tokens: 2500 }, output_tokens: 30 });
  };

  const msgs: EngineMsg[] = [];
  const engine = new Engine({ dataDir: path.join(dir, '.data'), mock: false, broadcast: (m) => msgs.push(m) });
  await engine.handle({ t: 'settings.set', patch: { memoryEnabled: false, openaiAuth: 'apiKey' } } as never);
  for (const name of ['Lead', 'UI', 'Engine', 'Reviewer']) {
    const cfg: SessionConfig = { name, cwd: dir, model: 'gpt-5.5', prompt: '', priority: 3, awareness: 'family', permission: 'auto', familyId: 'fam' };
    await engine.handle({ t: 'session.create', id: name.toLowerCase(), config: cfg });
  }
  await engine.handle({ t: 'session.send', id: 'lead', text: 'Build session templates with the team.' } as never);

  const total = () => Object.values(requests).reduce((a, b) => a + b, 0);
  let last = -1;
  let quiet = Date.now();
  const t0 = Date.now();
  while (Date.now() - t0 < 60_000) {
    await new Promise((r) => setTimeout(r, 200));
    if (total() !== last) (last = total()), (quiet = Date.now());
    else if (Date.now() - quiet > 3000) break;
  }
  const turns = new Map<string, number>();
  for (const m of msgs) if (m.t === 'session.state') turns.set(m.state.id, m.state.turns);
  const log = msgs.filter((m) => m.t === 'hub.message').map((m) => (m as any).message);
  await engine.shutdown();
  net.fetch = real;
  delete process.env.OPENAI_API_KEY;
  return { turns: [...turns.values()].reduce((a, b) => a + b, 0), wakes: log.filter((m) => m.kind === 'message' && m.woke).length, requests: total() };
}

test('openai: one user message on a 4-session family stays a handful of turns', async () => {
  const r = await simulate({ leadSteps: 1, latencyMs: 20 });
  if (process.env.SIM_LOG) console.log(r);
  assert.ok(r.turns <= 6, `expected <= 6 turns, got ${r.turns}`);
  assert.ok(r.wakes <= 6, `expected <= 6 wakes, got ${r.wakes}`);
});

test('openai: replies read mid-turn still count toward the wake chain', async () => {
  const r = await simulate({ leadSteps: 25, latencyMs: 150 });
  if (process.env.SIM_LOG) console.log(r);
  assert.ok(r.turns <= 6, `expected <= 6 turns, got ${r.turns}`);
  assert.ok(r.wakes <= 6, `expected <= 6 wakes, got ${r.wakes}`);
});
