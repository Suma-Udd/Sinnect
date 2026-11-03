// Starts Murmur in demo mode in your browser: fake sessions, no login, no cost.
//   npm run demo   then open http://127.0.0.1:4317
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [path.join(root, 'packages/engine/dist/engine.mjs')], {
  stdio: 'inherit',
  env: { ...process.env, MURMUR_MOCK: '1', MURMUR_UI: path.join(root, 'packages/ui/dist'), MURMUR_DATA: path.join(root, '.demo-data') },
});
console.log('Open http://127.0.0.1:4317 in your browser');
child.on('exit', (code) => process.exit(code ?? 0));
