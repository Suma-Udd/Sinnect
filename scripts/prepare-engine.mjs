// Gets the engine ready to ship inside the desktop app:
//  1. copies the bundled engine script into src-tauri/resources/engine
//  2. adds the Claude Code binary for the target platform (the SDK is bundled)
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

// 2. The Claude Code binary for the target platform. The SDK itself is bundled
//    into engine.mjs, so this is the only package we ship (one big file instead
//    of thousands of small ones, which keeps the installer fast).
const sdkVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')).version;
const binPkg = `@anthropic-ai/claude-agent-sdk-${os}-${cpu}`;
const nm = path.join(out, 'node_modules');
fs.rmSync(nm, { recursive: true, force: true });
for (const f of ['package.json', 'package-lock.json']) fs.rmSync(path.join(out, f), { force: true });
const dest0 = path.join(nm, ...binPkg.split('/'));
fs.mkdirSync(dest0, { recursive: true });
const tgz = execSync(`npm pack ${binPkg}@${sdkVersion} --silent --pack-destination "${nm}"`, { cwd: nm }).toString().trim().split('\n').pop();
execSync(`tar -xzf "${tgz}" -C "${dest0}" --strip-components=1`, { cwd: nm, stdio: 'inherit' });
fs.rmSync(path.join(nm, tgz));
console.log(`[prepare-engine] ${binPkg}@${sdkVersion} -> ${path.relative(root, dest0)}`);

// 3. Node binary named the way Tauri expects: binaries/node-<target>[.exe]
fs.mkdirSync(bins, { recursive: true });
const ext = os === 'win32' ? '.exe' : '';
const dest = path.join(bins, `node-${target}${ext}`);
const nodeBin = process.env.SINNECT_NODE_BIN || process.execPath;
fs.copyFileSync(nodeBin, dest);
fs.chmodSync(dest, 0o755);
console.log(`[prepare-engine] node from ${nodeBin} -> ${path.relative(root, dest)}`);
