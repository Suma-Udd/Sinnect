// A fake Gemini REST server for simulations and tests. It speaks the same
// streamGenerateContent?alt=sse protocol as Google, so GeminiSession runs its
// real code path (fetch, SSE parsing, tool loop, token counting). No real API
// key, no network, no cost.
//
// The "model" is a scripted policy you pass in. It sees the parsed request and
// returns parts (text and/or functionCall). Token counts are estimated from the
// request size (4 chars per token), and implicit caching works like Gemini's:
// the part of the request that matches the start of the session's previous
// request is billed as cached.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { net } from '../src/gemini-session.js';

export type Part = { text?: string; thought?: boolean; functionCall?: { name: string; args?: Record<string, unknown> }; functionResponse?: { name: string; response: Record<string, unknown> } };
export type Content = { role: 'user' | 'model'; parts: Part[] };
export interface GeminiRequest {
  model: string;
  systemInstruction: { parts: { text: string }[] };
  contents: Content[];
  tools: { functionDeclarations: { name: string }[] }[];
}

/** Return the parts the model "says" for this request. */
export type Policy = (req: GeminiRequest, session: string) => Part[];

export interface SessionStats {
  requests: number;
  promptTokens: number;
  cachedTokens: number;
  outputTokens: number;
}

const tok = (s: string) => Math.ceil(s.length / 4);
/** Gemini 2.5 Flash only caches prompts of at least this many tokens. */
const MIN_CACHE_TOKENS = 1024;

export async function startFakeGemini(policy: Policy, opts: { latencyMs?: number } = {}) {
  const stats = new Map<string, SessionStats>();
  const lastPrompt = new Map<string, string>();
  const requests: GeminiRequest[] = [];

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    if (req.method === 'GET' && url.pathname.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', supportedGenerationMethods: ['generateContent'] }] }));
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const parsed = JSON.parse(body) as GeminiRequest;
      parsed.model = decodeURIComponent(/models\/([^:]+):/.exec(url.pathname)?.[1] ?? '');
      requests.push(parsed);
      const sys = parsed.systemInstruction.parts.map((p) => p.text).join('');
      const session = /You are "([^"]+)"/.exec(sys)?.[1] ?? /folder (\S+)/.exec(sys)?.[1] ?? 'solo';
      // The prompt as Gemini sees it, in order: system, tools, chat.
      const prompt = JSON.stringify(parsed.systemInstruction) + JSON.stringify(parsed.tools) + JSON.stringify(parsed.contents);
      const prev = lastPrompt.get(session) ?? '';
      let same = 0;
      while (same < prev.length && same < prompt.length && prev.charCodeAt(same) === prompt.charCodeAt(same)) same++;
      lastPrompt.set(session, prompt);
      const promptTokens = tok(prompt);
      const cached = tok(prompt.slice(0, same)) >= MIN_CACHE_TOKENS ? tok(prompt.slice(0, same)) : 0;

      let parts: Part[];
      try {
        parts = policy(parsed, session);
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: 500, message: String(e) } }));
        return;
      }
      const out = tok(JSON.stringify(parts));
      const s = stats.get(session) ?? { requests: 0, promptTokens: 0, cachedTokens: 0, outputTokens: 0 };
      s.requests += 1;
      s.promptTokens += promptTokens;
      s.cachedTokens += cached;
      s.outputTokens += out;
      stats.set(session, s);

      // Real models take a while to answer, which matters for what arrives mid-turn.
      setTimeout(() => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Stream like Google does: text in small chunks, usage (cumulative) on chunks.
      const chunks: unknown[] = [];
      for (const p of parts) {
        if (typeof p.text === 'string' && p.text.length > 40) {
          for (let i = 0; i < p.text.length; i += 40) chunks.push({ candidates: [{ content: { role: 'model', parts: [{ ...p, text: p.text.slice(i, i + 40) }] } }] });
        } else chunks.push({ candidates: [{ content: { role: 'model', parts: [p] } }] });
      }
      chunks.push({ candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }], usageMetadata: { promptTokenCount: promptTokens, cachedContentTokenCount: cached, candidatesTokenCount: out } });
      for (const c of chunks) res.write(`data: ${JSON.stringify(c)}\r\n\r\n`);
      res.end();
      }, opts.latencyMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;

  // Point GeminiSession at us instead of Google.
  const realFetch = net.fetch;
  net.fetch = (input, init) => {
    const u = String(input).replace('https://generativelanguage.googleapis.com', `http://127.0.0.1:${port}`);
    return fetch(u, init);
  };

  return {
    stats,
    requests,
    async close() {
      net.fetch = realFetch;
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// ---------- helpers for writing policies ----------

export const call = (name: string, args: Record<string, unknown> = {}): Part => ({ functionCall: { name, args } });
export const say = (text: string): Part => ({ text });

/** The newest user content (task text, hub notices and/or tool results). */
export function lastUser(req: GeminiRequest): Content | undefined {
  return req.contents.findLast((c) => c.role === 'user');
}

/** Hub lines in the newest user content: [{ fromId, text }]. */
export function hubLines(req: GeminiRequest): { from: string; text: string }[] {
  const out: { from: string; text: string }[] = [];
  for (const p of lastUser(req)?.parts ?? []) {
    if (typeof p.text !== 'string' || !p.text.includes('[Sinnect hub]')) continue;
    for (const m of p.text.matchAll(/- from [^(\n]+\((\w+)\): (.*)/g)) out.push({ from: m[1], text: m[2] });
  }
  return out;
}

/** The plain (non hub) text the user typed in the newest user content, if any. */
export function userText(req: GeminiRequest): string {
  return (lastUser(req)?.parts ?? [])
    .filter((p) => typeof p.text === 'string' && !p.functionResponse)
    .map((p) => p.text!.replace(/\[Sinnect hub\][\s\S]*?(\n\n|$)/, ''))
    .join('\n')
    .trim();
}

/** How many tool rounds this turn has had so far (model replies since the last typed text). */
export function stepInTurn(req: GeminiRequest): number {
  let n = 0;
  for (let i = req.contents.length - 1; i >= 0; i--) {
    const c = req.contents[i];
    if (c.role === 'model') n++;
    // A turn starts with a user content that has no tool results in it.
    else if (!c.parts.some((p) => p.functionResponse)) break;
  }
  return n;
}

/** Session ids in the roster part of the system prompt. */
export function rosterIds(req: GeminiRequest): string[] {
  const sys = req.systemInstruction.parts.map((p) => p.text).join('');
  return [...sys.matchAll(/\(id (\w+),/g)].map((m) => m[1]);
}
