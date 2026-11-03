// Gets the engine ready to ship inside the desktop app:
//  1. copies the bundled engine script into src-tauri/resources/engine
//  2. installs the Claude Agent SDK there for the target platform
//  3. puts a Node binary in src-tauri/binaries for Tauri's sidecar
//
// Usage: node scripts/prepare-engine.mjs [--target x86_64-pc-windows-msvc]

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'src-tauri', 'resources', 'engine');
const bins = path.join(root, 'src-tauri', 'binaries');

const argTarget = process.argv.indexOf('--target');
const target =
  (argTarget > -1 && process.argv[argTarget + 1]) ||
  process.env.TAURI_ENV_TARGET_TRIPLE ||
  /host: (\S+)/.exec(execSync('rustc -vV').toString())[1];

const os = target.includes('windows') ? 'win32' : target.includes('apple') ? 'darwin' : 'linux';
const cpu = target.startsWith('aarch64') ? 'arm64' : 'x64';
console.log(`[prepare-engine] target ${target} (${os}-${cpu})`);

// 1. engine script
const built = path.join(root, 'packages', 'engine', 'dist', 'engine.mjs');
if (!fs.existsSync(built)) execSync('npm run build -w packages/engine', { cwd: root, stdio: 'inherit' });
fs.mkdirSync(out, { recursive: true });
fs.copyFileSync(built, path.join(out, 'engine.mjs'));

// 2. SDK for the target platform (it carries the Claude Code binary)
const enginePkg = JSON.parse(fs.readFileSync(path.join(root, 'packages', 'engine', 'package.json'), 'utf8'));
const sdkVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version;
fs.writeFileSync(
  path.join(out, 'package.json'),
  JSON.stringify({ name: 'sinnect-engine', private: true, type: 'module', version: enginePkg.version, dependencies: { '@anthropic-ai/claude-agent-sdk': sdkVersion } }, null, 2),
);
execSync(`npm install --omit=dev --no-audit --no-fund --os=${os} --cpu=${cpu}`, { cwd: out, stdio: 'inherit' });

// 3. Node binary named the way Tauri expects: binaries/node-<target>[.exe]
fs.mkdirSync(bins, { recursive: true });
const ext = os === 'win32' ? '.exe' : '';
const dest = path.join(bins, `node-${target}${ext}`);
const nodeBin = process.env.SINNECT_NODE_BIN || process.execPath;
fs.copyFileSync(nodeBin, dest);
fs.chmodSync(dest, 0o755);
console.log(`[prepare-engine] node from ${nodeBin} -> ${path.relative(root, dest)}`);
