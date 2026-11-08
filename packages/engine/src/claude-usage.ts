// The Claude plan's usage windows (5-hour and weekly), the same numbers
// Claude Code's /usage shows. Sinnect asks Claude Code itself through the
// Agent SDK: it opens a query without sending any message, reads the usage,
// and closes it. No model call, so it costs nothing, and Sinnect never sees
// the login.

import os from 'node:os';
import { query, type Options, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { bundledClaude } from './auth.js';
import type { PlanUsage } from './protocol.js';

type Win = { utilization: number | null; resets_at: string | null } | null | undefined;

export async function readClaudeUsage(claudePath: string | null): Promise<{ plan: string | null; usage: PlanUsage } | null> {
  const abort = new AbortController();
  let release = () => {};
  // A prompt stream that never sends anything, so no turn starts.
  async function* idle(): AsyncGenerator<SDKUserMessage> {
    await new Promise<void>((r) => (release = r));
  }
  const env: Record<string, string | undefined> = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  const options: Options = { cwd: os.homedir(), abortController: abort, env, settingSources: [], permissionMode: 'default' } as Options;
  const exe = claudePath || bundledClaude();
  if (exe) options.pathToClaudeCodeExecutable = exe;
  const q = query({ prompt: idle(), options });
  // Drain the stream so the process isn't blocked on output.
  void (async () => {
    try {
      for await (const _ of q) {
        /* nothing to do */
      }
    } catch {
      /* closed */
    }
  })();
  const timer = setTimeout(() => abort.abort(), 20_000);
  try {
    const res = await (q as unknown as { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(o: { skipBehaviors: boolean }): Promise<any> }).usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    return claudeUsageFrom(res);
  } finally {
    clearTimeout(timer);
    release();
    abort.abort();
  }
}

/** Turns the SDK's /usage answer into Sinnect's shape. null when the login has no plan limits (API key). */
export function claudeUsageFrom(res: any): { plan: string | null; usage: PlanUsage } | null {
  if (!res?.rate_limits_available || !res.rate_limits) return null;
  const win = (w: Win, mins: number) =>
    w && typeof w.utilization === 'number' ? { usedPercent: w.utilization, windowMins: mins, resetsAt: w.resets_at ? Math.round(Date.parse(w.resets_at) / 1000) : null } : null;
  const primary = win(res.rate_limits.five_hour, 300);
  const secondary = win(res.rate_limits.seven_day, 10_080);
  if (!primary && !secondary) return null;
  return { plan: res.subscription_type ?? null, usage: { primary, secondary, reached: (primary?.usedPercent ?? 0) >= 100 || (secondary?.usedPercent ?? 0) >= 100 } };
}
