// A tile for a subagent the model started with Claude Code's own Task/Agent tool.
//
// Sinnect normally turns that tool off and gives sessions spawn_workers instead, so helpers are
// real sessions on the canvas. But when helpers are off for a session, Claude can still use its
// built-in subagents, and those used to run invisibly inside the boss. This mirror makes them show
// up like any other helper: a card next to the boss, wired to it, with a live feed. It runs nothing
// itself, the boss's Claude Code process does the work and RealSession forwards what happens.

import { BaseSession } from './session.js';
import type { FeedItem } from './protocol.js';

export class SubagentSession extends BaseSession {
  start() {
    this.setStatus('working', 'Starting');
  }

  /** Nothing to drive: you can't message a built-in subagent, it answers only its boss. */
  send() {}
  protected pushInput() {}
  async interrupt() {}
  protected async shutdown() {}

  /** One step of the subagent's work, forwarded from the boss. */
  show(kind: FeedItem['kind'], text: string, extra: Partial<FeedItem> = {}, activity?: string) {
    if (this.closed) return;
    this.feed(kind, text, extra);
    if (activity) this.setStatus('working', activity);
  }

  /** Tokens of the subagent's own model calls, so caps and the boss card count them. */
  addTokens(t: { input: number; output: number; cacheRead: number; cacheWrite: number }) {
    if (this.closed) return;
    const s = this.state.tokens;
    s.input += t.input;
    s.output += t.output;
    s.cacheRead += t.cacheRead;
    s.cacheWrite += t.cacheWrite;
    this.publish();
  }
}
