// Writes latest.json, the file installed copies of Sinnect read to find updates.
// Usage: node scripts/latest-json.mjs <version> "<notes>" <platform>=<file> [<platform>=<file> ...]
//   e.g. windows-x86_64=Sinnect-Setup.exe darwin-aarch64=Sinnect-mac-arm64.app.tar.gz
// Each file needs its signature next to it as <file>.sig. Missing files are
// skipped, so a failed Mac build never blocks a Windows release.
import fs from 'node:fs';

const [version, notes = '', ...pairs] = process.argv.slice(2);
const repo = process.env.GITHUB_REPOSITORY || 'Suma-Udd/Sinnect';
const platforms = {};
for (const pair of pairs) {
  const [platform, file] = pair.split('=');
  if (!fs.existsSync(file) || !fs.existsSync(`${file}.sig`)) {
    console.warn(`skipping ${platform}: ${file} or its .sig is missing`);
    continue;
  }
  platforms[platform] = {
    signature: fs.readFileSync(`${file}.sig`, 'utf8').trim(),
    url: `https://github.com/${repo}/releases/download/v${version}/${file.split(/[\\/]/).pop()}`,
  };
}
if (!platforms['windows-x86_64']) {
  console.error('No Windows build, refusing to write latest.json');
  process.exit(1);
}
const out = { version, notes: notes || `Sinnect ${version}`, pub_date: new Date().toISOString(), platforms };
fs.writeFileSync('latest.json', JSON.stringify(out, null, 2));
console.log(fs.readFileSync('latest.json', 'utf8'));
