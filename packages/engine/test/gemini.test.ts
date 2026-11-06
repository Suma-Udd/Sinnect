import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Hub } from '../src/hub.js';
import { GeminiSession, globToRe, listGeminiModels, net } from '../src/gemini-session.js';
import type { SessionHost } from '../src/session.js';
import type { FeedItem, PromptRequest, SessionConfig, SessionState } from '../src/protocol.js';
import { providerOf } from '../src/protocol.js';

/** Builds a fake streamed Gemini reply out of chunks. */
function sseResponse(chunks: unknown[]) {
  const body = chunks.map((c) => `data: ${JSON.stringify(c)}\r\n\r\n`).join('');
  return new Response(new Blob([body]).stream(), { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function harness(replies: unknown[][], opts: Partial<SessionConfig> = {}, answer: 'allow' | 'deny' = 'allow') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sinnect-gem-'));
  const requests: any[] = [];
  let n = 0;
  net.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)));
    return sseResponse(replies[n++] ?? [{ candidates: [{ content: { role: 'model', parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] }]);
  };
  const feed: FeedItem[] = [];
  const asked: PromptRequest[] = [];
  let state: SessionState | null = null;
  let done!: () => void;
  const finished = new Promise<void>((r) => (done = r));
  const hub = new Hub({
    sessions: () => [{ id: 'g1', name: 'Gem', priority: 3, familyId: null, awareness: 'everyone', goal: '', status: 'working', activity: '' }],
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
    geminiKey: () => 'test-key',
    dataDir: dir,
    state: (s) => (state = s),
    feedAdd: (_id, item) => feed.push({ ...item }),
    feedDelta: (_id, itemId, text) => {
      const it = feed.findLast((i) => i.id === itemId);
      if (it) it.text += text;
    },
    ask: async (p) => (asked.push(p), { requestId: p.requestId, kind: 'tool', decision: answer }),
    nameOf: (id) => id,
    turnDone: () => done(),
    memoryContext: () => '',
    memoryTool: () => '',
    memoryOn: () => false,
  };
  const config: SessionConfig = { name: 'Gem', cwd: dir, model: 'gemini-flash-latest', prompt: '', priority: 3, awareness: 'everyone', permission: 'ask', ...opts };
  const s = new GeminiSession('g1', config, host);
  return { s, dir, feed, asked, requests, finished, state: () => state };
}

const call = (name: string, args: Record<string, unknown>) => ({ candidates: [{ content: { role: 'model', parts: [{ functionCall: { name, args }, thoughtSignature: 'sig1' }] } }] });

test('gemini models route to the Gemini backend', () => {
  assert.equal(providerOf('gemini-flash-latest'), 'gemini');
  assert.equal(providerOf('models/gemini-3.8-flash'), 'gemini');
  assert.equal(providerOf('claude-sonnet-5-5'), 'claude');
  assert.equal(providerOf(''), 'claude');
});

test('a turn streams text, writes a file after asking, and counts tokens', async () => {
  const h = harness([
    [
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Planning', thought: true }] } }] },
      call('write_file', { path: 'hello.txt', content: 'hi there' }),
      { usageMetadata: { promptTokenCount: 120, cachedContentTokenCount: 20, candidatesTokenCount: 15, thoughtsTokenCount: 5 } },
    ],
    [
      { candidates: [{ content: { role: 'model', parts: [{ text: 'Wrote ' }] } }] },
      { candidates: [{ content: { role: 'model', parts: [{ text: 'the file.' }] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 200, candidatesTokenCount: 4 } },
    ],
  ]);
  h.s.start();
  h.s.send('make hello.txt');
  await h.finished;

  assert.equal(fs.readFileSync(path.join(h.dir, 'hello.txt'), 'utf8'), 'hi there');
  assert.equal(h.asked.length, 1, 'ask mode asks before writing');
  assert.equal(h.asked[0].kind === 'tool' && h.asked[0].toolName, 'Write');
  assert.ok(h.feed.some((f) => f.kind === 'thinking' && f.text === 'Planning'));
  assert.ok(h.feed.some((f) => f.kind === 'text' && f.text === 'Wrote the file.'));
  assert.ok(h.feed.some((f) => f.kind === 'tool' && f.toolName === 'Write'));

  // second request carries the call (with its signature) and our result back
  const second = h.requests[1].contents;
  const model = second.find((c: any) => c.role === 'model' && c.parts.some((p: any) => p.functionCall));
  assert.equal(model.parts.find((p: any) => p.functionCall).thoughtSignature, 'sig1');
  assert.ok(second.at(-1).parts[0].functionResponse.response.result.startsWith('Wrote'));

  const t = h.s.state.tokens;
  assert.deepEqual(t, { input: 100 + 200, output: 20 + 4, cacheRead: 20, cacheWrite: 0 });
  assert.equal(h.s.state.status, 'idle');
  assert.ok(h.requests[0].tools[0].functionDeclarations.some((d: any) => d.name === 'hub_send'), 'hub tools offered');
});

test('a "no" on the prompt keeps the file untouched', async () => {
  const h = harness([[call('write_file', { path: 'x.txt', content: 'nope' })]], {}, 'deny');
  h.s.start();
  h.s.send('write x');
  await h.finished;
  assert.equal(fs.existsSync(path.join(h.dir, 'x.txt')), false);
  assert.match(h.requests[1].contents.at(-1).parts[0].functionResponse.response.error, /said no/);
});

test('edit_file replaces exact text, solo sessions get no hub tools', async () => {
  const h = harness([[call('edit_file', { path: 'a.ts', old_text: 'const a = 1;', new_text: 'const a = 2;' })]], { permission: 'acceptEdits', awareness: 'solo' });
  fs.writeFileSync(path.join(h.dir, 'a.ts'), 'x\r\nconst a = 1;\r\ny');
  h.s.start();
  h.s.send('bump a');
  await h.finished;
  assert.equal(fs.readFileSync(path.join(h.dir, 'a.ts'), 'utf8'), 'x\r\nconst a = 2;\r\ny');
  assert.equal(h.asked.length, 0);
  assert.ok(!h.requests[0].tools[0].functionDeclarations.some((d: any) => d.name.startsWith('hub_')));
});

test('rate limit errors leave the session usable', async () => {
  const h = harness([]);
  net.fetch = async () => new Response(JSON.stringify({ error: { code: 429, message: 'Quota exceeded' } }), { status: 429 });
  h.s.start();
  h.s.send('hi');
  await h.finished;
  assert.ok(h.feed.some((f) => f.kind === 'error' && /rate limit/.test(f.text)));
  assert.equal(h.s.state.status, 'idle');
});

test('model list keeps chat models only, aliases first', async () => {
  net.fetch = async () =>
    Response.json({
      models: [
        { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-embedding-001', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-3.8-flash', displayName: 'Gemini 3.8 Flash', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-flash-latest', displayName: 'Gemini Flash Latest', supportedGenerationMethods: ['generateContent'] },
        { name: 'models/gemini-2.5-flash-preview-tts', supportedGenerationMethods: ['generateContent'] },
      ],
    });
  const list = await listGeminiModels('k');
  assert.deepEqual(list.map((m) => m.id), ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-2.5-flash']);
});

test('glob helper', () => {
  assert.ok(globToRe('src/**/*.ts').test('src/a/b/c.ts'));
  assert.ok(globToRe('src/**/*.ts').test('src/c.ts'));
  assert.ok(globToRe('*.md').test('docs/readme.md'));
  assert.ok(!globToRe('src/*.ts').test('src/a/c.ts'));
  assert.ok(globToRe('*.{ts,tsx}').test('a/b.tsx'));
});
