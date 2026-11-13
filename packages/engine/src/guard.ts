// Small safety checks shared by the engine: who may connect, which files a
// session may never touch, and keeping text from one session from posing as
// something else when another session reads it.

import path from 'node:path';

const caseless = process.platform === 'win32' || process.platform === 'darwin';
const norm = (p: string) => {
  const n = path.resolve(p);
  return caseless ? n.toLowerCase() : n;
};

/** Is `file` the folder `root` itself or something inside it? */
export function isInside(root: string, file: string): boolean {
  const rel = path.relative(norm(root), norm(file));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Files no session may read or change through its file tools: the file with
 * the API keys. A session never needs it, and a prompt injection (a web page
 * or a README telling the model what to do) would love to read it.
 */
export function isSecretFile(dataDir: string, file: string): boolean {
  if (!dataDir) return false;
  const f = norm(file);
  const secrets = norm(path.join(dataDir, 'secrets.json'));
  return f === secrets || f === secrets + '.tmp';
}

export const SECRET_FILE_MESSAGE = "That file holds Sinnect's API keys. Sessions can't open it.";

// Control characters and the Unicode line separators count as line breaks too.
const BREAKS = new RegExp('[' + String.fromCharCode(0) + '-' + String.fromCharCode(31) + String.fromCharCode(127, 0x2028, 0x2029) + ']+', 'g');

/**
 * Squash text to a single line. Hub messages, goals and claim reasons are
 * pasted into other sessions' prompts as "- from Name: text" lines. With line
 * breaks in it, one session could make its message look like a notice from
 * the hub, a message from someone else, or even the user's own words.
 */
export function oneLine(text: string): string {
  return String(text ?? '').replace(BREAKS, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * May a page from this origin open the engine's WebSocket? Browsers let any
 * website connect to 127.0.0.1, so without this a web page open in the user's
 * browser could try to drive their sessions. Only the app's own window and
 * local pages (demo mode, the dev server) are allowed. Programs that aren't
 * browsers send no Origin and still need the token.
 */
export function allowedOrigin(origin: string | undefined): boolean {
  if (!origin || origin === 'null') return !origin;
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (u.protocol === 'tauri:') return u.hostname === 'localhost';
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]' || u.hostname === 'tauri.localhost';
}

/** Compare two secrets without leaking how many characters matched through timing. */
export function sameToken(a: unknown, b: string): boolean {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * A web link that is safe to hand to the operating system's "open" command.
 * Returns the cleaned-up link, or null if it isn't a plain http(s) link.
 */
export function safeWebUrl(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const href = u.href;
  // Parsing already escapes quotes and spaces; refuse anything that could still break out of a quoted command line.
  return /["\s^`]/.test(href) ? null : href;
}
