// Boss / helper sessions: a session hands self-contained sub-tasks to helper
// sessions that run in parallel, each on a model that fits the job, and gets
// one short summary back from each. Helpers never message anyone, so they
// can't start a wake ping-pong; their only output is the summary.

import type { WorkerKind } from './protocol.js';
import { WORKER_KINDS, WORKER_KIND_LABEL } from './protocol.js';

export interface WorkerSpec {
  task: string;
  kind?: WorkerKind;
  /** A model the boss asked for: an exact id or a short name like "sonnet". */
  model?: string;
}

export const SPAWN_MODEL_DOC =
  'Optional. Use it when the user asks for a model ("use Sonnet"): haiku, sonnet, opus, a Gemini or GPT model name, or an exact model id. Leave it out and Sinnect picks a model for the kind of job.';

/**
 * Turns "sonnet", "Sonnet 5.5", "gemini flash" or an exact id into a model id from the lists we know.
 * Returns null when nothing matches, so the caller can say so instead of guessing.
 */
export function resolveModelName(asked: string, known: { id: string; label: string }[]): string | null {
  const want = asked.trim().toLowerCase().replace(/^claude[\s-]+/, '');
  if (!want) return null;
  const exact = known.find((m) => m.id.toLowerCase() === asked.trim().toLowerCase());
  if (exact) return exact.id;
  const norm = (s: string) => s.toLowerCase().replace(/[\s_.-]+/g, ' ').trim();
  const w = norm(want);
  const hit = known.find((m) => norm(m.label) === w) ?? known.find((m) => norm(m.label).includes(w) || norm(m.id).includes(w));
  if (hit) return hit.id;
  // An id we don't list yet (a newer model): let the provider check decide.
  return /^(claude|gemini|gpt|o\d|codex|chatgpt)/i.test(asked.trim()) ? asked.trim() : null;
}

/** Kinds that only look at things. Their helpers can't edit files. */
export const READ_ONLY_KINDS = new Set<WorkerKind>(['search', 'read', 'review', 'plan']);

export interface SpawnOptions {
  /** Block until every helper is done instead of running them in the background. */
  wait?: boolean;
}

export const SUMMARY_MAX = 1200;
/** Finished helpers kept per boss (stopped, off the board, transcript still openable from the boss). */
export const KEEP_DONE_HELPERS = 20;
/**
 * Background helpers report in a new boss turn, and a boss could answer every report by spawning
 * again, forever. So a boss gets this many helper rounds per message from you, then has to stop.
 */
export const MAX_SPAWN_ROUNDS = 3;
export const WORKER_TIMEOUT_MS = 20 * 60_000;

// Fallback keyword rules, checked in this order when the start of the task doesn't settle it.
const RULES: [WorkerKind, RegExp][] = [
  ['test', /\b(tests?|specs?|jest|vitest|pytest|mocha|failing|ci\b|lint|typecheck|type-check|build (it|passes)|run (the )?(build|suite))/i],
  ['plan', /\b(plan|design|architect(ure)?|approach|strategy|break (it|this) down|roadmap|proposal)\b/i],
  ['review', /\b(review|audit|critique|check (the |my )?(diff|changes|pr)|look for bugs|security)\b/i],
  ['search', /\b(find|search|grep|locate|where (is|are|do)|which files?|list (all|every)|look up|look for)\b/i],
  ['read', /\b(read|summari[sz]e|explain|understand|go through|what does|skim|docs?)\b/i],
  ['code', /\b(implement|add|write|fix|change|refactor|create|update|rename|remove|delete|migrate|build)\b/i],
];

/** What the task opens with says the most about the job. */
const LEAD: [WorkerKind, RegExp][] = [
  ['plan', /^(please\s+)?((write|draft|make|create)\s+(a|an|the)\s+(plan|design|proposal|roadmap|outline)|plan|design|architect|outline|propose|break)\b/i],
  ['review', /^(please\s+)?(review|audit|critique|look for (bugs|problems|issues)|check (the |my |this )?(diff|changes|pr|code))\b/i],
];
const LEAD_LOOK: [WorkerKind, RegExp][] = [
  ['test', /^(please\s+)?(run|rerun|re-run|execute)\b.*\b(tests?|suite|specs?|build|lint|typecheck|type-check|ci)\b/i],
  ['search', /^(please\s+)?(find|search|grep|locate|list|look (for|up)|where)\b/i],
  ['read', /^(please\s+)?(read|summari[sz]e|explain|understand|go through|skim|describe|what)\b/i],
];
/**
 * A verb that changes files, at the start of a clause ("fix X", "find X and fix it", "run the tests, then fix them").
 * A job like that needs a helper that can edit, so it beats "find", "read" and "run tests". Nouns like
 * "the change" don't count, they don't start a clause.
 */
const CHANGE = /(^|[,.;:]\s*|\b(and|then|to|please|also)\s+)(implement|add|write|fix|change|refactor|create|update|rename|remove|delete|migrate|replace|convert|make(?! sure))\b/i;

/** Free, instant guess at what kind of job a task is. The boss can always say it explicitly. */
export function classifyTask(task: string): WorkerKind {
  const t = task.trim();
  for (const [kind, re] of LEAD) if (re.test(t)) return kind;
  if (CHANGE.test(t)) return 'code';
  for (const [kind, re] of LEAD_LOOK) if (re.test(t)) return kind;
  for (const [kind, re] of RULES) if (re.test(t)) return kind;
  return 'code';
}

// Commands a look-only helper may run. Anything else (or anything that writes through a redirect) is refused.
const SAFE_CMD =
  /^(cd|ls|dir|cat|type|head|tail|wc|grep|egrep|fgrep|rg|ag|find|tree|pwd|echo|stat|file|du|which|where|sort|uniq|cut|jq|git\s+(--no-pager\s+)?(diff|log|show|status|blame|grep|ls-files|ls-tree|rev-parse|describe|shortlog|cat-file)|npm\s+(ls|list|view|outdated)|get-childitem|gci|get-content|gc|select-string|sls|get-item|measure-object|test-path|resolve-path)(\s|$)/i;
const UNSAFE_PART = /\s-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b|--output\b|\bsort\b.*\s-o\b/i;

/**
 * True when a shell command only looks at things. Used for search, read, review and plan helpers,
 * so they can still run `git diff` or `grep` but can't change files through the shell.
 * Errs on the side of saying no: anything unusual is refused.
 */
export function isReadOnlyCommand(command: string): boolean {
  const cmd = command
    .trim()
    .replace(/\s2>&1/g, '')
    .replace(/\s2>\s*(\/dev\/null|\$null|nul)\b/gi, '');
  if (!cmd) return false;
  if (/[>`\n\r;]|\$\(|<\(/.test(cmd)) return false;
  return cmd.split(/&&|\|\||\|/).every((part) => {
    const p = part.trim();
    return SAFE_CMD.test(p) && !UNSAFE_PART.test(p);
  });
}

export const READ_ONLY_SHELL_MSG =
  'This helper can only look, not change files. Use the read and search tools, or read-only commands like git diff, git log, git show, ls, cat, grep or find (no redirects).';

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
    readOnly
      ? 'Only look, do not change any files. The shell only takes read-only commands (git diff, git log, ls, cat, grep, find).'
      : 'Keep changes to what the job needs. Other sessions may be editing nearby files.',
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
  'They show up on the user\'s canvas. By default they run in the background: this returns right away, and once all of them are done you get one [Sinnect helpers] message with a short summary from each. ' +
  'Set wait=true only if you can\'t do anything else until they report. ' +
  'Use it for broad searches, reading many files, running tests, or independent changes in separate files. ' +
  "Don't use it for things you can do in one or two tool calls. Give each helper everything it needs in the task text, it can't see your conversation.";

export const SPAWN_WAIT_DOC = 'true = wait here until every helper is done and get their summaries as the result. Default false: they run in the background and report in one message.';

/** Header of the message that hands background helper summaries to the boss. Mock sessions look for it too. */
export const HELPERS_TAG = '[Sinnect helpers]';
