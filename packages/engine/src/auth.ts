// Sign-in helpers for "My Claude login" mode. Sinnect never touches the
// login itself: it only checks whether Claude Code is signed in on this PC,
// and opens the bundled Claude Code in a terminal window so the user can
// sign in there the normal way.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire as makeRequire } from 'node:module';

const configDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

/** true = signed in, false = not signed in. */
export function isSignedIn(): boolean {
  try {
    if (fs.existsSync(path.join(configDir(), '.credentials.json'))) return true;
    const globalCfg = process.env.CLAUDE_CONFIG_DIR
      ? path.join(process.env.CLAUDE_CONFIG_DIR, '.claude.json')
      : path.join(os.homedir(), '.claude.json');
    if (fs.existsSync(globalCfg)) {
      const cfg = JSON.parse(fs.readFileSync(globalCfg, 'utf8'));
      if (cfg?.oauthAccount) return true;
    }
  } catch {
    /* unreadable means we can't tell, treat as not signed in */
  }
  return false;
}

/** The Claude Code binary that ships with the Agent SDK, if we can find it. */
export function bundledClaude(): string | null {
  const req = makeRequire(import.meta.url);
  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const pkg of [`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`, `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}-musl`]) {
    try {
      const dir = path.dirname(req.resolve(`${pkg}/package.json`));
      const bin = path.join(dir, 'claude' + ext);
      if (fs.existsSync(bin)) return bin;
    } catch {
      /* not installed for this platform */
    }
  }
  return null;
}

/** Opens a terminal window running Claude Code so the user can sign in. */
export function openLogin(claudePath: string | null): string | null {
  const bin = claudePath || bundledClaude() || 'claude';
  const cwd = os.homedir();
  try {
    if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', `start "Sign in to Claude" "${bin}"`], { cwd, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    } else if (process.platform === 'darwin') {
      const script = `tell application "Terminal" to do script "cd ~ && '${bin.replace(/'/g, "'\\''")}'"`;
      spawn('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('x-terminal-emulator', ['-e', bin], { cwd, detached: true, stdio: 'ignore' }).unref();
    }
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
}
