// A session backed by OpenAI's API (GPT-5, GPT-4.1, o3, o4-mini, Codex models).
// The agent loop, the tools and the chat history are shared with Gemini in
// loop-session.ts; this file only talks to OpenAI's Responses API: it streams a
// reply, hands tool calls to the shared runner, and sends the results back.
//
// Requests are stateless (store: false), so nothing is kept on OpenAI's side
// and the whole chat lives on this computer like the Gemini one. Reasoning
// models get their reasoning back on every step as encrypted items, so they
// don't have to re-think from scratch after each tool call.

import { clip } from './session.js';
import { openaiLabel } from './protocol.js';
import { ApiError, apiMessage, HISTORY_SOFT_LIMIT, LoopSession, MAX_STEPS, net, sse, type SessionTokens, type ToolSpec } from './loop-session.js';

const API = 'https://api.openai.com/v1';

/** Items of a Responses API conversation, as far as Sinnect uses them. */
type Item =
  | { type: 'message'; role: 'user' | 'assistant' | 'developer'; content: string | { type: string; text?: string }[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }
  | { type: 'reasoning'; summary: { type: string; text: string }[]; encrypted_content?: string | null };

type Usage = { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } };

/** How much reasoning to ask for. Steps down when a model or account refuses a part. */
type ReasoningMode = 'summary' | 'encrypted' | 'off';

const openaiTool = (t: ToolSpec) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false });

/** Models that think before answering (o-series, GPT-5 family, Codex). */
export const isReasoningModel = (m: string) => /^(o\d|gpt-5|codex)/i.test(m) && !/chat/i.test(m);

export class OpenAISession extends LoopSession {
  protected readonly provider = 'openai';
  private items: Item[] = [];
  private mode: ReasoningMode = isReasoningModel(this.config.model) ? 'summary' : 'off';

  private get model() {
    return this.config.model;
  }

  // ---------- the agent loop ----------

  protected async runTurn(text: string) {
    const started = Date.now();
    this.items.push({ type: 'message', role: 'user', content: text });
    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.closed || this.stopTurn) break;
      this.trimHistory();
      const out = await this.generate();
      this.items.push(...out);
      const calls = out.filter((i): i is Extract<Item, { type: 'function_call' }> => i.type === 'function_call');
      if (!calls.length) break;

      for (const c of calls) {
        if (this.closed || this.stopTurn) {
          this.items.push({ type: 'function_call_output', call_id: c.call_id, output: 'Error: stopped by the user.' });
          continue;
        }
        let args: Record<string, unknown> = {};
        try {
          args = c.arguments ? JSON.parse(c.arguments) : {};
        } catch {
          this.items.push({ type: 'function_call_output', call_id: c.call_id, output: 'Error: the arguments were not valid JSON. Try again.' });
          continue;
        }
        const r = await this.runTool(c.name, args);
        this.items.push({ type: 'function_call_output', call_id: c.call_id, output: r.error ? `Error: ${r.error}` : (r.result ?? '') });
      }
      // Hub notices ride along with the tool results, like the Claude hook does.
      const notice = this.takeNoticeText();
      if (notice) this.items.push({ type: 'message', role: 'user', content: notice });
      if (step === MAX_STEPS - 1) this.feed('system', `Paused after ${MAX_STEPS} tool steps. Say "continue" to keep going.`);
    }
    this.turnFinished(started);
  }

  /** A call without its output makes the next request fail, so cut back to the last complete step. */
  protected dropPartialReply() {
    const answered = new Set(this.items.flatMap((i) => (i.type === 'function_call_output' ? [i.call_id] : [])));
    while (this.items.length) {
      const last = this.items.at(-1)!;
      if (last.type === 'function_call' && !answered.has(last.call_id)) this.items.pop();
      else if (last.type === 'reasoning') this.items.pop();
      else break;
    }
    // Calls left in the middle without outputs (stopped mid-step) get a stub so the chat stays valid.
    for (let i = 0; i < this.items.length; i++) {
      const it = this.items[i];
      if (it.type === 'function_call' && !answered.has(it.call_id)) {
        this.items.splice(i + 1, 0, { type: 'function_call_output', call_id: it.call_id, output: 'Error: stopped.' });
        answered.add(it.call_id);
      }
    }
  }

  /** One streamed model call. Returns the output items, and streams text into the feed as it arrives. */
  private async generate(): Promise<Item[]> {
    const key = this.host.openaiKey();
    if (!key) throw new Error('No OpenAI API key. Add one in Settings.');
    this.abort = new AbortController();
    const body: Record<string, unknown> = {
      model: this.model,
      instructions: this.systemPrompt(),
      input: this.items,
      tools: this.toolSpecs().map(openaiTool),
      stream: true,
      store: false,
      // Keeps every request of this session on the same cache, so the long fixed start is billed at the cached price.
      prompt_cache_key: this.state.sdkSessionId ?? this.id,
    };
    if (this.mode !== 'off') {
      body.reasoning = this.mode === 'summary' ? { summary: 'auto' } : {};
      body.include = ['reasoning.encrypted_content'];
    }

    const res = await net.fetch(`${API}/responses`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
      signal: this.abort.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Reasoning summaries need a verified organization, and some models don't reason at all. Step down and retry.
      if (res.status === 400 && this.mode === 'summary' && /summar|verif/i.test(detail)) {
        this.mode = 'encrypted';
        return this.generate();
      }
      if (res.status === 400 && this.mode !== 'off' && /reasoning|include|encrypted/i.test(detail)) {
        this.mode = 'off';
        this.items = this.items.filter((i) => i.type !== 'reasoning');
        return this.generate();
      }
      throw new ApiError(res.status, apiMessage(detail) || `HTTP ${res.status}`);
    }

    const out: Item[] = [];
    /** Feed items being streamed into, by the API's item id (and summary part). */
    const live = new Map<string, string>();
    const stream = (key: string, kind: 'text' | 'thinking', delta: string) => {
      if (!delta) return;
      let feedId = live.get(key);
      if (!feedId) {
        feedId = this.feed(kind, '').id;
        live.set(key, feedId);
        this.setStatus(kind === 'thinking' ? 'thinking' : 'working', kind === 'thinking' ? 'Thinking' : 'Writing a reply');
      }
      this.host.feedDelta(this.id, feedId, delta);
    };
    let done = false;

    for await (const { event, data } of sse(res)) {
      const type: string = data?.type ?? event;
      switch (type) {
        case 'response.output_text.delta':
          stream(`t:${data.item_id}`, 'text', data.delta ?? '');
          break;
        case 'response.reasoning_summary_text.delta':
          stream(`r:${data.item_id}:${data.summary_index ?? 0}`, 'thinking', data.delta ?? '');
          break;
        case 'response.output_item.done': {
          const item = clean(data.item);
          if (item) out.push(item);
          break;
        }
        case 'response.completed':
        case 'response.incomplete': {
          done = true;
          if (data.response?.usage) this.count(data.response.usage);
          const why = data.response?.incomplete_details?.reason;
          if (type === 'response.incomplete' && why) {
            this.feed('error', why === 'max_output_tokens' ? 'The reply hit the length limit and was cut off. Say "continue".' : `OpenAI stopped the reply (${String(why).replace(/_/g, ' ')}).`, { isError: true });
          }
          break;
        }
        case 'response.failed': {
          const e = data.response?.error ?? {};
          throw new ApiError(500, e.message ?? 'OpenAI could not finish the reply');
        }
        case 'error':
          throw new ApiError(statusOf(data.code ?? data.error?.code), data.message ?? data.error?.message ?? 'OpenAI error');
      }
    }
    if (!done && !out.length) throw new Error('OpenAI closed the connection before answering. Send again.');
    return out;
  }

  private count(u: Usage) {
    const cached = u.input_tokens_details?.cached_tokens ?? 0;
    const input = Math.max(0, (u.input_tokens ?? 0) - cached);
    const output = u.output_tokens ?? 0;
    const price = openaiPrice(this.model);
    this.state.costUsd += (input * price.input + cached * price.cached + output * price.output) / 1_000_000;
    const t: SessionTokens = this.state.tokens;
    this.state.tokens = { input: t.input + input, output: t.output + output, cacheRead: t.cacheRead + cached, cacheWrite: t.cacheWrite };
    this.publish();
  }

  // ---------- history ----------

  /** Old tool outputs get cut down once the chat gets long, so each turn stays cheap. */
  private trimHistory() {
    let size = JSON.stringify(this.items).length;
    if (size < HISTORY_SOFT_LIMIT) return;
    for (const it of this.items.slice(0, -16)) {
      if (it.type === 'function_call_output' && it.output.length > 300) {
        size -= it.output.length;
        it.output = it.output.slice(0, 200) + '\n[old output trimmed]';
      }
      if (size < HISTORY_SOFT_LIMIT * 0.6) break;
    }
  }

  protected historyData() {
    return { model: this.model, items: this.items };
  }

  protected restoreHistory(data: unknown) {
    const saved = (data as { model?: string; items?: Item[] }).items ?? [];
    // Encrypted reasoning only works with the model that wrote it.
    const sameModel = (data as { model?: string }).model === this.model;
    this.items = saved.filter((i) => i.type !== 'reasoning' || (sameModel && this.mode !== 'off'));
    for (const it of this.items) {
      if (it.type === 'message') {
        const text = typeof it.content === 'string' ? it.content : it.content.map((c) => c.text ?? '').join('');
        if (text && !text.startsWith('[Sinnect hub]')) this.feed(it.role === 'user' ? 'user' : 'text', text);
      } else if (it.type === 'function_call') {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(it.arguments || '{}');
        } catch {
          /* show it without arguments */
        }
        this.replayTool(it.name, args);
      }
    }
  }

  protected friendlyError(err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') return 'Stopped';
    if (err instanceof ApiError) {
      if (err.status === 401) return 'OpenAI says the API key is not valid. Check it in Settings.';
      if (err.status === 429 && /quota|billing|credit/i.test(err.message)) return 'Your OpenAI account is out of credits. Add some at platform.openai.com/settings/billing, then send again.';
      if (err.status === 429) return `OpenAI rate limit hit. Wait a bit and send again. ${clip(err.message, 160)}`;
      if (err.status === 404) return `OpenAI doesn't know this model, or this key can't use it. Pick another one. ${clip(err.message, 160)}`;
      if (err.status === 403) return `OpenAI refused the request: ${clip(err.message, 200)}`;
      return `OpenAI error ${err.status}: ${clip(err.message, 300)}`;
    }
    return err instanceof Error ? err.message : String(err);
  }
}

/**
 * Keep only what the next request needs. Ids are dropped because nothing is
 * stored on OpenAI's side (store: false), so it couldn't look them up.
 */
function clean(raw: any): Item | null {
  if (!raw || typeof raw !== 'object') return null;
  switch (raw.type) {
    case 'message':
      return { type: 'message', role: 'assistant', content: (raw.content ?? []).filter((c: any) => c.type === 'output_text' || c.type === 'refusal').map((c: any) => ({ type: 'output_text', text: c.text ?? c.refusal ?? '' })) };
    case 'function_call':
      return { type: 'function_call', call_id: raw.call_id, name: raw.name, arguments: raw.arguments ?? '{}' };
    case 'reasoning':
      // Without the encrypted part it can't be sent back, and the summary was already shown.
      return raw.encrypted_content ? { type: 'reasoning', summary: raw.summary ?? [], encrypted_content: raw.encrypted_content } : null;
    default:
      return null;
  }
}

function statusOf(code: unknown): number {
  if (typeof code === 'number') return code;
  if (code === 'rate_limit_exceeded' || code === 'insufficient_quota') return 429;
  if (code === 'invalid_api_key') return 401;
  if (code === 'model_not_found') return 404;
  return 500;
}

/**
 * Rough price per million tokens, so the board budget and the helper spend cap
 * work for OpenAI sessions too. Cached input is much cheaper on OpenAI.
 */
export function openaiPrice(model: string): { input: number; output: number; cached: number } {
  const m = model.toLowerCase();
  const p = (input: number, output: number, cached = input / 4) => ({ input, output, cached });
  if (/^gpt-5/.test(m)) {
    if (/nano/.test(m)) return p(0.05, 0.4, 0.005);
    if (/mini/.test(m)) return p(0.25, 2, 0.025);
    if (/pro/.test(m)) return p(15, 120, 15);
    return p(1.25, 10, 0.125);
  }
  if (/^gpt-4\.1/.test(m)) return /nano/.test(m) ? p(0.1, 0.4) : /mini/.test(m) ? p(0.4, 1.6) : p(2, 8);
  if (/^gpt-4o/.test(m)) return /mini/.test(m) ? p(0.15, 0.6, 0.075) : p(2.5, 10, 1.25);
  if (/^o1-pro/.test(m)) return p(150, 600, 150);
  if (/^o3-pro/.test(m)) return p(20, 80, 20);
  if (/^o1/.test(m)) return p(15, 60, 7.5);
  if (/^o3-mini|^o4-mini|^o1-mini/.test(m)) return p(1.1, 4.4, 0.275);
  if (/^o3/.test(m)) return p(2, 8, 0.5);
  if (/codex-mini/.test(m)) return p(1.5, 6, 0.375);
  return p(1.25, 10, 0.125);
}

/** Ask OpenAI which models this key can use, and keep the ones that can run a coding agent. */
export async function listOpenAIModels(key: string): Promise<{ id: string; label: string }[]> {
  const res = await net.fetch(`${API}/models`, { headers: { authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(apiMessage(await res.text().catch(() => '')) || `HTTP ${res.status}`);
  const data = (await res.json()) as { data?: { id: string }[] };
  return (data.data ?? [])
    .map((m) => m.id)
    .filter(isAgentModel)
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((id) => ({ id, label: openaiLabel(id) }));
}

/** Chat models with tool calling. Leaves out audio, images, embeddings, dated snapshots and old models. */
export function isAgentModel(id: string) {
  if (!/^(gpt-|o\d|codex)/i.test(id)) return false;
  if (/audio|realtime|tts|transcribe|image|search|embed|instruct|moderation|computer-use|deep-research|oss|diarize/i.test(id)) return false;
  if (/^gpt-3|^gpt-4(-|$)|^o1-(mini|preview)|^chatgpt/i.test(id)) return false;
  // Dated snapshots ("gpt-4o-2024-08-06", "o3-mini-2025-01-31") only clutter the picker.
  if (/-\d{4}-\d{2}-\d{2}$|-\d{4}$/.test(id)) return false;
  return true;
}

/** Newest family first (GPT-5.x, then o-series, then GPT-4.x), the full model before mini and nano. */
function rank(id: string) {
  let family = 0;
  const g = /^gpt-(\d+(?:\.\d+)?)/i.exec(id);
  const o = /^o(\d+)/i.exec(id);
  if (g) family = parseFloat(g[1]) * 10;
  else if (o) family = 44 + Number(o[1]);
  else family = 45;
  const size = /nano/.test(id) ? 4 : /mini/.test(id) ? 3 : /pro/.test(id) ? 5 : /chat/.test(id) ? 6 : /codex/.test(id) ? 1 : 0;
  return -family * 10 + size;
}
