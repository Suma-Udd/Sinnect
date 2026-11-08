import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../src/hub.js';
import { net } from '../src/loop-session.js';
import { OpenAISession, isAgentModel, listOpenAIModels, openaiPrice } from '../src/openai-session.js';
import type { SessionHost } from '../src/session.js';
import type { FeedItem, PromptRequest, SessionConfig, SessionState } from '../src/protocol.js';
import { openaiLabel, providerOf } from '../src/protocol.js';

/** Builds a fake streamed Responses API reply out of events, the way OpenAI sends them. */
function sseResponse(events: any[]) {
  const body = events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('');
  return new Response(new Blob([body]).stream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const done = (usage = { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } }) => ({ type: 'response.completed', response: { usage } });
const text = (t: string, id = 'msg_1') => [
  { type: 'response.output_item.added', item: { type: 'message', id } },
  ...t.match(/.{1,5}/g)!.map((d) => ({ type: 'response.output_text.delta', item_id: id, delta: d })),
  { type: 'response.output_item.done', item: { type: 'message', id, role: 'assistant', content: [{ type: 'output_text', text: t, annotations: [] }] } },
];
const call = (name: string, args: Record<string, unknown>, callId = 'call_1') => ({
  type: 'response.output_item.done',
  item: { type: 'function_call', id: `fc_${callId}`, call_id: callId, name, arguments: JSON.stringify(args), status: 'completed' },
});
const reasoning = (summary: string) => [
  { type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', summary_index: 0, delta: summary },
  { type: 'response.output_item.done', item: { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: summary }], encrypted_content: 'ENC' } },
];

function harness(replies: any[][], opts: Partial<SessionConfig> = {}, answer: 'allow' | 'deny' = 'allow') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-oai-'));
  const requests: any[] = [];
  const urls: string[] = [];
  let n = 0;
  net.fetch = async (url, init) => {
    urls.push(String(url));
    requests.push(JSON.parse(String(init?.body)));
    return sseResponse(replies[n++] ?? [...text('ok'), done()]);
  };
  const feed: FeedItem[] = [];
  const asked: PromptRequest[] = [];
  let state: SessionState | null = null;
  let finish!: () => void;
  const finished = new Promise<void>((r) => (finish = r));
  const hub = new Hub({
    sessions: () => [{ id: 'o1', name: 'Gpt', priority: 3, familyId: null, awareness: 'everyone', goal: '', status: 'working', activity: '' }],
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
    openaiKey: () => 'sk-test',
    dataDir: dir,
    state: (s) => (state = s),
    feedAdd: (_id, item) => feed.push({ ...item }),
    feedDelta: (_id, itemId, t) => {
      const it = feed.findLast((i) => i.id === itemId);
      if (it) it.text += t;
    },
    ask: async (p) => (asked.push(p), { requestId: p.requestId, kind: 'tool', decision: answer }),
    nameOf: (id) => id,
    turnDone: () => finish(),
    memoryContext: () => '',
    memoryTool: () => '',
    memoryOn: () => false,
    canSpawn: () => false,
    spawnWorkers: async () => '',
  };
  const config: SessionConfig = { name: 'Gpt', cwd: dir, model: 'gpt-5-mini', prompt: '', priority: 3, awareness: 'everyone', permission: 'ask', ...opts };
  const s = new OpenAISession('o1', config, host);
  return { s, dir, feed, asked, requests, urls, finished, state: () => state, host };
}

test('openai models route to the OpenAI backend', () => {
  for (const m of ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4o', 'o3', 'o4-mini', 'codex-mini-latest']) assert.equal(providerOf(m), 'openai', m);
  assert.equal(providerOf('opus'), 'claude');
  assert.equal(providerOf('claude-opus-5-5'), 'claude');
  assert.equal(providerOf('gemini-flash-latest'), 'gemini');
});

test('a turn streams reasoning and text, writes a file after asking, and counts tokens', async () => {
  const h = harness([
    [...reasoning('Planning the file'), call('write_file', { path: 'hello.txt', content: 'hi there' }), done({ input_tokens: 1200, output_tokens: 40, input_tokens_details: { cached_tokens: 1000 } })],
    [...text('Wrote the file.'), done({ input_tokens: 1300, output_tokens: 5, input_tokens_details: { cached_tokens: 1200 } })],
  ]);
  h.s.start();
  h.s.send('make hello.txt');
  await h.finished;

  assert.equal(fs.readFileSync(path.join(h.dir, 'hello.txt'), 'utf8'), 'hi there');
  assert.equal(h.asked.length, 1, 'ask mode asks before writing');
  assert.equal(h.asked[0].kind === 'tool' && h.asked[0].toolName, 'Write');
  assert.ok(h.feed.some((f) => f.kind === 'thinking' && f.text === 'Planning the file'));
  assert.ok(h.feed.some((f) => f.kind === 'text' && f.text === 'Wrote the file.'));
  assert.ok(h.feed.some((f) => f.kind === 'tool' && f.toolName === 'Write'));

  const [first, second] = h.requests;
  assert.equal(h.urls[0], 'https://api.openai.com/v1/responses');
  assert.equal(first.model, 'gpt-5-mini');
  assert.equal(first.store, false);
  assert.equal(first.stream, true);
  assert.deepEqual(first.include, ['reasoning.encrypted_content']);
  assert.deepEqual(first.reasoning, { summary: 'auto' });
  assert.ok(first.instructions.includes('Sinnect'));
  assert.ok(first.tools.some((t: any) => t.type === 'function' && t.name === 'hub_send' && t.parameters.type === 'object'), 'hub tools offered');

  // The second request carries the reasoning (encrypted, no ids), the call and our result back.
  const r = second.input.find((i: any) => i.type === 'reasoning');
  assert.equal(r.encrypted_content, 'ENC');
  assert.equal(r.id, undefined);
  const fc = second.input.find((i: any) => i.type === 'function_call');
  assert.equal(fc.call_id, 'call_1');
  assert.equal(fc.id, undefined);
  const out = second.input.at(-1);
  assert.equal(out.type, 'function_call_output');
  assert.equal(out.call_id, 'call_1');
  assert.ok(out.output.startsWith('Wrote'));
  assert.equal(second.instructions, first.instructions, 'system prompt stays the same so caching works');
  assert.equal(second.prompt_cache_key, first.prompt_cache_key);

  assert.deepEqual(h.s.state.tokens, { input: 200 + 100, output: 45, cacheRead: 2200, cacheWrite: 0 });
  const p = openaiPrice('gpt-5-mini');
  const usd = (300 * p.input + 2200 * p.cached + 45 * p.output) / 1e6;
  assert.ok(Math.abs(h.s.state.costUsd - usd) < 1e-12);
  assert.equal(h.s.state.status, 'idle');
});

test('a "no" on the prompt keeps the file untouched', async () => {
  const h = harness([[call('write_file', { path: 'x.txt', content: 'nope' }), done()]], {}, 'deny');
  h.s.start();
  h.s.send('write x');
  await h.finished;
  assert.equal(fs.existsSync(path.join(h.dir, 'x.txt')), false);
  assert.match(h.requests[1].input.at(-1).output, /said no/);
});

test('edit_file and solo sessions, non-reasoning models get no reasoning params', async () => {
  const h = harness([[call('edit_file', { path: 'a.ts', old_text: 'const a = 1;', new_text: 'const a = 2;' }), done()]], { permission: 'acceptEdits', awareness: 'solo', model: 'gpt-4.1' });
  fs.writeFileSync(path.join(h.dir, 'a.ts'), 'x\nconst a = 1;\ny');
  h.s.start();
  h.s.send('bump a');
  await h.finished;
  assert.equal(fs.readFileSync(path.join(h.dir, 'a.ts'), 'utf8'), 'x\nconst a = 2;\ny');
  assert.equal(h.asked.length, 0);
  assert.ok(!h.requests[0].tools.some((t: any) => t.name.startsWith('hub_')));
  assert.equal(h.requests[0].reasoning, undefined);
  assert.equal(h.requests[0].include, undefined);
});

test('an unverified org without reasoning summaries still works', async () => {
  const h = harness([]);
  let n = 0;
  const bodies: any[] = [];
  net.fetch = async (_u, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    if (n++ === 0) return new Response(JSON.stringify({ error: { message: 'Your organization must be verified to generate reasoning summaries.' } }), { status: 400 });
    return sseResponse([...text('hello'), done()]);
  };
  h.s.start();
  h.s.send('hi');
  await h.finished;
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[1].reasoning, {});
  assert.ok(h.feed.some((f) => f.kind === 'text' && f.text === 'hello'));
});

test('out of credits and bad keys read as plain errors, and the session stays usable', async () => {
  const h = harness([]);
  net.fetch = async () => new Response(JSON.stringify({ error: { message: 'You exceeded your current quota, please check your plan and billing details.', code: 'insufficient_quota' } }), { status: 429 });
  h.s.start();
  h.s.send('hi');
  await h.finished;
  assert.ok(h.feed.some((f) => f.kind === 'error' && /out of credits/.test(f.text)));
  assert.equal(h.s.state.status, 'idle');
});

test('the chat is saved and comes back on resume', async () => {
  const h = harness([[call('read_file', { path: 'missing.txt' }), done()], [...text('All good.'), done()]]);
  h.s.start();
  h.s.send('look around');
  await h.finished;
  const resumeId = h.s.state.sdkSessionId!;
  assert.ok(resumeId.startsWith('openai-'));
  assert.ok(fs.existsSync(path.join(h.dir, 'openai', `${resumeId}.json`)));

  const again = new OpenAISession('o2', { ...h.s.config, resumeId }, { ...h.host, feedAdd: (_id, item) => feed2.push(item) });
  const feed2: FeedItem[] = [];
  again.start();
  assert.ok(feed2.some((f) => f.kind === 'user' && f.text === 'look around'));
  assert.ok(feed2.some((f) => f.kind === 'tool' && f.toolName === 'Read'));
  assert.ok(feed2.some((f) => f.kind === 'text' && f.text === 'All good.'));
});

test('model list keeps agent models, newest first, with readable names', async () => {
  net.fetch = async () =>
    Response.json({
      data: ['gpt-4o', 'gpt-4o-2024-08-06', 'gpt-5-mini', 'text-embedding-3-small', 'gpt-4.1', 'o4-mini', 'gpt-5', 'gpt-realtime', 'dall-e-3', 'gpt-5-nano', 'gpt-3.5-turbo', 'o3', 'gpt-5.1-codex', 'gpt-image-1', 'gpt-4o-mini-tts', 'whisper-1', 'gpt-4-turbo'].map((id) => ({ id })),
    });
  const list = await listOpenAIModels('k');
  assert.deepEqual(list.map((m) => m.id), ['gpt-5.1-codex', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano', 'o4-mini', 'o3', 'gpt-4.1', 'gpt-4o']);
  assert.deepEqual(list.slice(0, 3).map((m) => m.label), ['GPT-5.1 Codex', 'GPT-5', 'GPT-5 mini']);
  assert.equal(openaiLabel('o4-mini'), 'o4-mini');
  assert.ok(!isAgentModel('o1-mini'));
});
