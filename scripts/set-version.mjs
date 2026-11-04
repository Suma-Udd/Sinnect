// Sets the app version everywhere it lives. Usage: node scripts/set-version.mjs 0.1.1
import fs from 'node:fs';

const v = process.argv[2];
if (!/^\d+\.\d+\.\d+$/.test(v ?? '')) {
  console.error('Give a version like 0.1.1');
  process.exit(1);
}
const json = (p, fn) => {
  const data = JSON.parse(fs.readFileSync(p, 'utf8'));
  fn(data);
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
};
json('src-tauri/tauri.conf.json', (c) => (c.version = v));
for (const p of ['package.json', 'packages/engine/package.json', 'packages/ui/package.json']) json(p, (c) => (c.version = v));
json('package-lock.json', (c) => {
  c.version = v;
  for (const k of ['', 'packages/engine', 'packages/ui']) if (c.packages?.[k]) c.packages[k].version = v;
});
const cargo = 'src-tauri/Cargo.toml';
fs.writeFileSync(cargo, fs.readFileSync(cargo, 'utf8').replace(/^version = ".*"$/m, `version = "${v}"`));
const lock = 'src-tauri/Cargo.lock';
fs.writeFileSync(lock, fs.readFileSync(lock, 'utf8').replace(/(\[\[package\]\]\nname = "sinnect"\nversion = ")[^"]*"/, `$1${v}"`));
console.log(`version set to ${v}`);
