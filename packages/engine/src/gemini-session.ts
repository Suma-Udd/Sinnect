// A session backed by Google's Gemini API (works with the free key from
// aistudio.google.com). The agent loop, the tools and the chat history are
// shared with the other own-loop providers in loop-session.ts; this file only
// talks to Gemini: it streams a reply, hands tool calls to the shared runner,
// and sends the results back in Gemini's format.

import { clip } from './session.js';
import { ApiError, apiMessage, HISTORY_SOFT_LIMIT, LoopSession, MAX_STEPS, net, sse, type Schema, type SessionTokens, type ToolSpec } from './loop-session.js';

export { globToRe, net } from './loop-session.js';

const API = 'https://generativelanguage.googleapis.com/v1beta';

type Part = {
  text?: string;
  thought?: boolean;
  thoughtSignature?: string;
  functionCall?: { name: string; args?: Record<string, unknown>; id?: string };
  functionResponse?: { name: string; response: Record<string, unknown>; id?: string };
};
type Content = { role: 'user' | 'model'; parts: Part[] };
type Usage = { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number };

/** Gemini spells JSON Schema types in capitals ("STRING", "OBJECT"). */
function geminiSchema(s: Schema): Record<string, unknown> {
  const out: Record<string, unknown> = { ...s, type: s.type.toUpperCase() };
  if (s.properties) out.properties = Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, geminiSchema(v)]));
  if (s.items) out.items = geminiSchema(s.items);
  return out;
}
const geminiDecl = (t: ToolSpec) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.parameters) });

export class GeminiSession extends LoopSession {
  protected readonly provider = 'gemini';
  private contents: Content[] = [];
  private noThinking = false;
  /** Cost before the request that's streaming now (see count). */
  private costBase: { tokens: SessionTokens; usd: number } | null = null;

  private get model() {
    return this.config.model.replace(/^models\//, '');
  }

  // ---------- the agent loop ----------

  protected async runTurn(text: string) {
    const started = Date.now();
    this.addUser([{ text }]);
    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.closed || this.stopTurn) break;
      this.trimHistory();
      const parts = await this.generate();
      if (parts.length) this.contents.push({ role: 'model', parts });
      const calls = parts.filter((p) => p.functionCall);
      if (!calls.length) break;

      const replies: Part[] = [];
      for (const c of calls) {
        const fc = c.functionCall!;
        if (this.closed || this.stopTurn) {
          replies.push({ functionResponse: { name: fc.name, id: fc.id, response: { error: 'Stopped by the user.' } } });
          continue;
        }
        const out = await this.runTool(fc.name, fc.args ?? {});
        replies.push({ functionResponse: { name: fc.name, id: fc.id, response: out.error ? { error: out.error } : { result: out.result } } });
      }
      // Hub notices ride along with the tool results, like the Claude hook does.
      const notice = this.takeNoticeText();
      if (notice) replies.push({ text: notice });
      this.addUser(replies);
      if (step === MAX_STEPS - 1) this.feed('system', `Paused after ${MAX_STEPS} tool steps. Say "continue" to keep going.`);
    }
    this.turnFinished(started);
  }

  protected dropPartialReply() {
    while (this.contents.at(-1)?.role === 'model') this.contents.pop();
  }

  /** Messages must alternate roles, so a second user message merges into the last one. */
  private addUser(parts: Part[]) {
    const last = this.contents.at(-1);
    if (last?.role === 'user') last.parts.push(...parts);
    else this.contents.push({ role: 'user', parts });
  }

  /** One streamed model call. Returns the reply's parts, and streams text into the feed as it arrives. */
  private async generate(): Promise<Part[]> {
    const key = this.host.geminiKey();
    if (!key) throw new Error('No Gemini API key. Add one in Settings.');
    this.abort = new AbortController();
    const body: Record<string, unknown> = {
      systemInstruction: { parts: [{ text: this.systemPrompt() }] },
      contents: this.contents,
      tools: [{ functionDeclarations: this.toolSpecs().map(geminiDecl) }],
    };
    if (!this.noThinking) body.generationConfig = { thinkingConfig: { includeThoughts: true } };

    const res = await net.fetch(`${API}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify(body),
      signal: this.abort.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Some models don't think. Retry once without asking for thoughts.
      if (res.status === 400 && !this.noThinking && /thinking/i.test(detail)) {
        this.noThinking = true;
        return this.generate();
      }
      throw new ApiError(res.status, apiMessage(detail) || `HTTP ${res.status}`);
    }

    const base = { ...this.state.tokens };
    const parts: Part[] = [];
    let live: { itemId: string; thought: boolean } | null = null;
    let finish = '';

    for await (const { data: chunk } of sse(res)) {
      if (chunk.error) throw new ApiError(chunk.error.code ?? 500, chunk.error.message ?? 'Gemini error');
      if (chunk.promptFeedback?.blockReason) throw new Error(`Gemini blocked the request: ${chunk.promptFeedback.blockReason}`);
      const cand = chunk.candidates?.[0];
      if (cand?.finishReason) finish = cand.finishReason;
      for (const p of (cand?.content?.parts ?? []) as Part[]) {
        if (p.functionCall) {
          live = null;
          parts.push(p);
          continue;
        }
        if (typeof p.text !== 'string') {
          if (p.thoughtSignature) attachSignature(parts, p.thoughtSignature);
          continue;
        }
        const thought = !!p.thought;
        const prev = parts.at(-1);
        if (prev && typeof prev.text === 'string' && !!prev.thought === thought && !prev.functionCall) {
          prev.text += p.text;
          if (p.thoughtSignature && !prev.thoughtSignature) prev.thoughtSignature = p.thoughtSignature;
        } else parts.push({ ...p });
        if (!p.text) continue;
        if (!live || live.thought !== thought) {
          live = { itemId: this.feed(thought ? 'thinking' : 'text', '').id, thought };
          this.setStatus(thought ? 'thinking' : 'working', thought ? 'Thinking' : 'Writing a reply');
        }
        this.host.feedDelta(this.id, live.itemId, p.text);
      }
      if (chunk.usageMetadata) this.count(base, chunk.usageMetadata);
    }

    if (!parts.length && finish && finish !== 'STOP') {
      this.feed('error', `Gemini stopped without an answer (${finish.toLowerCase().replace(/_/g, ' ')}).`, { isError: true });
    }
    return parts;
  }

  private count(base: SessionTokens, u: Usage) {
    const cached = u.cachedContentTokenCount ?? 0;
    if (!this.costBase || this.costBase.tokens !== base) this.costBase = { tokens: base, usd: this.state.costUsd };
    const price = geminiPrice(this.model);
    const input = Math.max(0, (u.promptTokenCount ?? 0) - cached);
    const output = (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0);
    // Usage numbers in a stream are running totals for this request, so cost starts from the request's base too.
    this.state.costUsd = this.costBase.usd + (input * price.input + cached * price.input * 0.25 + output * price.output) / 1_000_000;
    this.state.tokens = {
      input: base.input + Math.max(0, (u.promptTokenCount ?? 0) - cached),
      output: base.output + (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
      cacheRead: base.cacheRead + cached,
      cacheWrite: base.cacheWrite,
    };
    this.publish();
  }

  // ---------- history ----------

  /** Old tool outputs get cut down once the chat gets long, so each turn stays cheap. */
  private trimHistory() {
    let size = JSON.stringify(this.contents).length;
    if (size < HISTORY_SOFT_LIMIT) return;
    for (const c of this.contents.slice(0, -8)) {
      for (const p of c.parts) {
        const r = p.functionResponse?.response;
        if (r && typeof r.result === 'string' && r.result.length > 300) {
          size -= r.result.length;
          r.result = r.result.slice(0, 200) + '\n[old output trimmed]';
        }
      }
      if (size < HISTORY_SOFT_LIMIT * 0.6) break;
    }
  }

  protected historyData() {
    return { model: this.model, contents: this.contents };
  }

  protected restoreHistory(data: unknown) {
    this.contents = (data as { contents?: Content[] }).contents ?? [];
    for (const c of this.contents) {
      for (const p of c.parts) {
        if (p.text && !p.thought && !p.text.startsWith('[Sinnect hub]')) this.feed(c.role === 'user' ? 'user' : 'text', p.text);
        else if (p.functionCall) this.replayTool(p.functionCall.name, p.functionCall.args ?? {});
      }
    }
  }

  protected friendlyError(err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return 'Stopped';
    if (err instanceof ApiError) {
      if (err.status === 429) return `Gemini rate limit hit (the free key has per-minute and per-day limits). Wait a bit and send again. ${clip(err.message, 160)}`;
      if (err.status === 400 && /api key/i.test(err.message)) return 'Gemini says the API key is not valid. Check it in Settings.';
      if (err.status === 403) return `Gemini refused the key: ${clip(err.message, 200)}`;
      if (err.status === 404) return `Gemini doesn't know this model. Pick another one. ${clip(err.message, 160)}`;
      return `Gemini error ${err.status}: ${clip(err.message, 300)}`;
    }
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Rough paid-tier price per million tokens. Free keys pay nothing, but without
 * a number here the board budget and the helper spend cap would never stop a
 * Gemini session. Cached input is billed at a quarter of the input price.
 */
export function geminiPrice(model: string): { input: number; output: number } {
  const m = model.toLowerCase();
  if (/lite/.test(m)) return { input: 0.1, output: 0.4 };
  if (/pro/.test(m)) return /gemini-[3-9]/.test(m) ? { input: 2, output: 12 } : { input: 1.25, output: 10 };
  if (/gemini-2\.0/.test(m)) return { input: 0.1, output: 0.4 };
  return { input: 0.3, output: 2.5 };
}

/** Ask Google which chat models this key can use. */
export async function listGeminiModels(key: string): Promise<{ id: string; label: string }[]> {
  const res = await net.fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
  if (!res.ok) throw new Error(apiMessage(await res.text().catch(() => '')) || `HTTP ${res.status}`);
  const data = (await res.json()) as { models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[] };
  return (data.models ?? [])
    .filter((m) => m.supportedGenerationMethods?.includes('generateContent'))
    .map((m) => ({ id: m.name.replace(/^models\//, ''), label: m.displayName || m.name }))
    .filter((m) => /^gemini/.test(m.id) && !/embed|tts|image|live|audio|vision|aqa|robotics|computer-use|native/i.test(m.id))
    .sort((a, b) => rank(a.id) - rank(b.id));
}

/** Moving "-latest" aliases first, then newest versions. */
function rank(id: string) {
  if (id.endsWith('-latest')) return -1000;
  const v = parseFloat(/gemini-(\d+(?:\.\d+)?)/.exec(id)?.[1] ?? '0');
  return -v * 10 + (/preview|exp/.test(id) ? 1 : 0);
}

function attachSignature(parts: Part[], sig: string) {
  const last = parts.at(-1);
  if (last && !last.thoughtSignature) last.thoughtSignature = sig;
  else parts.push({ text: '', thoughtSignature: sig });
}
