// Writes latest.json, the file installed copies of Sinnect read to find updates.
// Usage: node scripts/latest-json.mjs <version> <installer.exe> <installer.exe.sig> "<notes>"
import fs from 'node:fs';

const [version, exe, sig, notes = ''] = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY || 'Suma-Udd/Sinnect';
const file = exe.split(/[\\/]/).pop();
const out = {
  version,
  notes: notes || `Sinnect ${version}`,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature: fs.readFileSync(sig, 'utf8').trim(),
      url: `https://github.com/${repo}/releases/download/v${version}/${file}`,
    },
  },
};
fs.writeFileSync('latest.json', JSON.stringify(out, null, 2));
console.log(fs.readFileSync('latest.json', 'utf8'));
