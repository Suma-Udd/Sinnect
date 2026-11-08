import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { Hub } from '../src/hub.js';
import { CodexSession } from '../src/codex-session.js';
import { codexModels, findCodex, planUsage } from '../src/codex.js';
import type { SessionHost } from '../src/session.js';
import type { FeedItem, PromptRequest, SessionConfig } from '../src/protocol.js';

// These run OpenAI's real Codex app (app-server) against a fake OpenAI server,
// so the whole ChatGPT-plan path is exercised without an account. Skipped when
// Codex isn't installed (set SINNECT_CODEX to point at one).
const bin = process.env.SINNECT_CODEX || findCodex(null);

test('model and usage helpers read Codex answers', () => {
  assert.deepEqual(codexModels({ data: [{ id: 'gpt-6.1-sol', displayName: 'GPT-6.1-Sol', hidden: false }, { id: 'x', hidden: true }, { id: 'gpt-5.5', displayName: 'GPT-5.5' }] }), [
    { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
    { id: 'gpt-5.5', label: 'GPT-5.5' },
  ]);
  assert.equal(planUsage({ primary: null, secondary: null }), null);
  assert.deepEqual(planUsage({ primary: { usedPercent: 42, windowDurationMins: 300, resetsAt: 9 }, secondary: null, rateLimitReachedType: null }), {
    primary: { usedPercent: 42, windowMins: 300, resetsAt: 9 },
    secondary: null,
    reached: false,
  });
});

type Step = (body: any) => any[];

async function fakeOpenAI(steps: Step[]) {
  const bodies: any[] = [];
  let n = 0;
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      if (req.method !== 'POST') return void res.writeHead(404).end();
      const body = JSON.parse(raw);
      bodies.push(body);
      const id = `resp_${++n}`;
      const items = (steps[n - 1] ?? (() => [{ type: 'message', role: 'assistant', id: `msg_${n}`, content: [{ type: 'output_text', text: 'Done.' }] }]))(body);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const ev = (e: any) => res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
      ev({ type: 'response.created', response: { id } });
      for (const item of items) {
        if (item.type === 'message') ev({ type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: item.content[0].text });
        ev({ type: 'response.output_item.done', item });
      }
      ev({ type: 'response.completed', response: { id, usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1020 } } });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as AddressInfo).port, bodies, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function harness(port: number, answer: 'allow' | 'deny', opts: Partial<SessionConfig> = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-codex-'));
  const home = path.join(dir, '.codex-home');
  fs.mkdirSync(home);
  fs.writeFileSync(
    path.join(home, 'config.toml'),
    `model_provider = "fake"\n[model_providers.fake]\nname = "fake"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nenv_key = "FAKE_OPENAI_KEY"\n`,
  );
  process.env.CODEX_HOME = home;
  process.env.FAKE_OPENAI_KEY = 'x';
  process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
  const work = path.join(dir, 'work');
  fs.mkdirSync(work);
  const feed: FeedItem[] = [];
  const asked: PromptRequest[] = [];
  let turns = 0;
  let onTurn = () => {};
  const hub = new Hub({
    sessions: () => [
      { id: 'c1', name: 'Gpt', priority: 3, familyId: null, awareness: 'everyone', goal: '', status: 'working', activity: '' },
      { id: 'c2', name: 'Other', priority: 3, familyId: null, awareness: 'everyone', goal: 'tests', status: 'idle', activity: '' },
    ],
    links: () => [],
    limits: () => ({ maxMessageChars: 500, maxMessagesPerHour: 30, maxNegotiationRounds: 2, maxWakeChain: 2, maxWakesPerHour: 8 }),
    deliver: () => {},
    openPrompt: () => {},
    closePrompt: () => {},
    claimsChanged: () => {},
    messageLogged: () => {},
  });
  const host: SessionHost = {
    hub,
    settings: () => ({}) as never,
    apiKey: () => null,
    geminiKey: () => null,
    openaiKey: () => null,
    codexBin: () => bin,
    dataDir: dir,
    state: () => {},
    feedAdd: (_id, item) => feed.push({ ...item }),
    feedDelta: (_id, itemId, t) => {
      const it = feed.findLast((i) => i.id === itemId);
      if (it) it.text += t;
    },
    ask: async (p) => (asked.push(p), { requestId: p.requestId, kind: 'tool', decision: answer }),
    nameOf: (id) => id,
    turnDone: () => (turns++, onTurn()),
    memoryContext: () => '',
    memoryTool: () => '',
    memoryOn: () => false,
    canSpawn: () => false,
    spawnWorkers: async () => '',
  };
  const config: SessionConfig = { name: 'Gpt', cwd: work, model: 'gpt-5.5', prompt: '', priority: 3, awareness: 'everyone', permission: 'ask', ...opts };
  const s = new CodexSession('c1', config, host);
  const nextTurn = () => new Promise<void>((r) => (onTurn = r));
  return { s, work, feed, asked, nextTurn, turns: () => turns };
}

const fn = (n: number, name: string, args: object) => ({ type: 'function_call', id: `fc_${n}`, call_id: `call_${n}`, name, arguments: JSON.stringify(args) });
const outputOf = (body: any, callId: string) => body.input.find((i: any) => i.call_id === callId && /output/.test(i.type))?.output;

test('ChatGPT mode: Codex runs Sinnect tools, asks before commands and edits, and counts tokens', { skip: !bin && 'Codex is not installed', timeout: 60_000 }, async () => {
  const fake = await fakeOpenAI([
    () => [fn(1, 'hub_roster', {})],
    () => [fn(2, 'exec_command', { cmd: 'echo sinnect-ok' })],
    () => [{ type: 'custom_tool_call', id: 'ct_3', call_id: 'call_3', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: hello.txt\n+hi there\n*** End Patch\n' }],
    () => [{ type: 'message', role: 'assistant', id: 'msg_4', content: [{ type: 'output_text', text: 'All done.' }] }],
  ]);
  const h = harness(fake.port, 'allow');
  try {
    h.s.start();
    const done = h.nextTurn();
    h.s.send('look around');
    await done;

    // Sinnect's own tools reached the model as Codex dynamic tools, and the roster came back.
    const first = fake.bodies[0];
    assert.ok(first.tools.some((t: any) => t.name === 'hub_send'));
    assert.ok(!first.tools.some((t: any) => t.name === 'read_file'), 'Codex uses its own file tools');
    assert.equal(first.store, false);
    assert.match(JSON.stringify(first.input), /Sinnect canvas/);
    assert.match(String(outputOf(fake.bodies[1], 'call_1') ?? JSON.stringify(fake.bodies[1].input)), /Other/);

    // The command and the file change were both put to the user first.
    assert.deepEqual(h.asked.map((a) => a.kind === 'tool' && a.toolName), ['Bash', 'Edit']);
    assert.match(JSON.stringify(fake.bodies[2].input), /sinnect-ok/);
    assert.equal(fs.readFileSync(path.join(h.work, 'hello.txt'), 'utf8').trim(), 'hi there');

    assert.ok(h.feed.some((f) => f.kind === 'tool' && f.toolName === 'Bash'));
    assert.ok(h.feed.some((f) => f.kind === 'tool' && (f.toolName === 'Write' || f.toolName === 'Edit')));
    assert.ok(h.feed.some((f) => f.kind === 'text' && /All done/.test(f.text)));
    assert.equal(h.s.state.tokens.cacheRead, 4 * 800);
    assert.ok(h.s.state.costUsd > 0, 'an API-equivalent estimate so budgets work');
    assert.ok(h.s.state.sdkSessionId?.startsWith('codex-'));
  } finally {
    await h.s.stop();
    await fake.close();
  }
});

test('ChatGPT mode: a "no" stops the command and a claimed file is not edited', { skip: !bin && 'Codex is not installed', timeout: 60_000 }, async () => {
  const fake = await fakeOpenAI([() => [fn(1, 'exec_command', { cmd: 'echo should-not-run > ran.txt' })]]);
  const h = harness(fake.port, 'deny');
  try {
    h.s.start();
    const done = h.nextTurn();
    h.s.send('run it');
    await done;
    assert.equal(h.asked.length, 1);
    assert.equal(fs.existsSync(path.join(h.work, 'ran.txt')), false);
  } finally {
    await h.s.stop();
    await fake.close();
  }
});

test('ChatGPT mode: a file another session holds is not edited, and hub notices reach the running turn', { skip: !bin && 'Codex is not installed', timeout: 60_000 }, async () => {
  const fake = await fakeOpenAI([
    () => [fn(1, 'hub_roster', {})],
    () => [{ type: 'custom_tool_call', id: 'ct_2', call_id: 'call_2', name: 'apply_patch', input: '*** Begin Patch\n*** Add File: taken.txt\n+mine\n*** End Patch\n' }],
  ]);
  const h = harness(fake.port, 'allow', { permission: 'auto' });
  try {
    const hub = (h.s as any).host.hub as Hub;
    const taken = path.join(h.work, 'taken.txt');
    hub.claim('c2', [normalize(taken)], 'writing it');
    h.s.start();
    const done = h.nextTurn();
    h.s.send('write taken.txt');
    // A message from another session lands while the first tool runs.
    h.s.deliver({ id: 'm1', from: 'c2', to: 'c1', text: 'use port 5180', ts: Date.now(), kind: 'message' } as never, false);
    await done;
    assert.equal(fs.existsSync(taken), false, 'claimed file stays untouched');
    assert.ok(h.feed.some((f) => f.kind === 'system' && /Blocked from editing/.test(f.text)));
    assert.ok(fake.bodies.some((b) => JSON.stringify(b.input).includes('use port 5180')), 'the notice reached the model mid-turn');
    assert.equal(h.asked.length, 0, 'Full auto never asks');
  } finally {
    await h.s.stop();
    await fake.close();
  }
});

function normalize(p: string) {
  const n = path.normalize(p);
  return process.platform === 'win32' || process.platform === 'darwin' ? n.toLowerCase() : n;
}
