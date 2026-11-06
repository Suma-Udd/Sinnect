// Boss / helper sessions: a session hands self-contained sub-tasks to helper
// sessions that run in parallel, each on a model that fits the job, and gets
// one short summary back from each. Helpers never message anyone, so they
// can't start a wake ping-pong; their only output is the summary.

import type { WorkerKind } from './protocol.js';
import { WORKER_KINDS, WORKER_KIND_LABEL } from './protocol.js';

export interface WorkerSpec {
  task: string;
  kind?: WorkerKind;
  model?: string;
}

/** Kinds that only look at things. Their helpers can't edit files. */
export const READ_ONLY_KINDS = new Set<WorkerKind>(['search', 'read', 'review', 'plan']);

export const SUMMARY_MAX = 1200;
export const WORKER_TIMEOUT_MS = 20 * 60_000;

const RULES: [WorkerKind, RegExp][] = [
  ['test', /\b(tests?|specs?|jest|vitest|pytest|mocha|failing|ci\b|lint|typecheck|type-check|build (it|passes)|run (the )?(build|suite))/i],
  ['plan', /\b(plan|design|architect(ure)?|approach|strategy|break (it|this) down|roadmap|proposal)\b/i],
  ['review', /\b(review|audit|critique|check (the |my )?(diff|changes|pr)|look for bugs|security)\b/i],
  ['search', /\b(find|search|grep|locate|where (is|are|do)|which files?|list (all|every)|look up|look for)\b/i],
  ['read', /\b(read|summari[sz]e|explain|understand|go through|what does|skim|docs?)\b/i],
  ['code', /\b(implement|add|write|fix|change|refactor|create|update|rename|remove|delete|migrate|build)\b/i],
];

/** Free, instant guess at what kind of job a task is. The boss can always say it explicitly. */
export function classifyTask(task: string): WorkerKind {
  for (const [kind, re] of RULES) if (re.test(task)) return kind;
  return 'code';
}

export function isWorkerKind(k: unknown): k is WorkerKind {
  return typeof k === 'string' && (WORKER_KINDS as string[]).includes(k);
}

/** The helper's first (and usually only) message. Short, and it ends with how to report back. */
export function workerPrompt(task: string, kind: WorkerKind, bossName: string): string {
  const readOnly = READ_ONLY_KINDS.has(kind);
  return [
    `You are a helper session. "${bossName}" gave you one job (${WORKER_KIND_LABEL[kind].toLowerCase()}):`,
    '',
    task.trim(),
    '',
    readOnly ? 'Only look, do not change any files.' : 'Keep changes to what the job needs. Other sessions may be editing nearby files.',
    'Work fast and stay on the job. When done, reply with ONE short summary (max ~150 words) for the boss: what you found or did, exact file paths and line numbers, anything that failed. No greetings, no next steps unless they matter. That reply is the only thing the boss sees.',
  ].join('\n');
}

/** Short name for the helper card. */
export function workerName(task: string, kind: WorkerKind) {
  const t = task.replace(/\s+/g, ' ').trim();
  const short = t.length > 44 ? t.slice(0, 43).trimEnd() + '…' : t;
  return `${WORKER_KIND_LABEL[kind]}: ${short}`;
}

export function clipSummary(s: string) {
  const t = s.trim();
  return t.length > SUMMARY_MAX ? t.slice(0, SUMMARY_MAX - 1) + '…' : t;
}

export const SPAWN_TOOL_DOC =
  'Hand self-contained sub-tasks to helper sessions that run in parallel, each on a model picked for the job (cheap fast models for search, reading and tests). ' +
  'Returns when all are done with one short summary each. Use it for broad searches, reading many files, running tests, or independent changes in separate files. ' +
  "Don't use it for things you can do in one or two tool calls. Give each helper everything it needs in the task text, it can't see your conversation.";
