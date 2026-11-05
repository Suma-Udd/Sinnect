#!/usr/bin/env bash
# Installs Sinnect from the .dmg on a Mac runner the way a person would
# (open the dmg, drag the app to Applications), opens it, and checks the
# window and the engine come up. Screenshots go to the output folder.
# Usage: scripts/mac-smoke.sh Sinnect-mac-arm64.dmg smoke-mac
set -uo pipefail
dmg="$1"; out="${2:-smoke-mac}"
mkdir -p "$out"
n=0
shot() { screencapture -x "$out/$(printf %04d $n).png" 2>/dev/null; n=$((n+1)); }
film() { local end=$((SECONDS+$1)); while [ $SECONDS -lt $end ]; do shot; sleep 1; done; }

echo "== mounting $dmg"
mnt=$(hdiutil attach -nobrowse -readonly "$dmg" | grep -o '/Volumes/.*' | head -1)
echo "mounted at $mnt"; ls -la "$mnt"
app_src=$(ls -d "$mnt"/*.app | head -1)
[ -n "$app_src" ] || { echo "::error::no .app inside the dmg"; exit 1; }
rm -rf /Applications/Sinnect.app
cp -R "$app_src" /Applications/
hdiutil detach "$mnt" -quiet || true
app=/Applications/Sinnect.app

echo "== bundle"
ls -la "$app/Contents/MacOS" "$app/Contents/Resources"
exe="$app/Contents/MacOS/$(/usr/libexec/PlistBuddy -c 'Print CFBundleExecutable' "$app/Contents/Info.plist")"
echo "executable: $exe"; file "$exe" "$app/Contents/MacOS/node"
codesign -dv "$app" 2>&1 | sed 's/^/  /'
codesign --verify --deep "$app" && echo "signature ok (ad-hoc)" || echo "::warning::codesign --verify failed"
"$app/Contents/MacOS/node" -e 'console.log("bundled node", process.version, process.arch)' || { echo "::error::bundled node won't run"; exit 1; }
claude_bin=$(find "$app/Contents/Resources" -type f -name claude | head -1)
echo "bundled claude: $claude_bin"
[ -n "$claude_bin" ] && "$claude_bin" --version || echo "::warning::bundled claude didn't print a version"

echo "== opening Sinnect"
data="$HOME/Library/Application Support/dev.sinnect.app"
rm -f "$data/engine.log" "${TMPDIR:-/tmp}/sinnect-start.log"
film 1
open "$app"
ok=0
for i in $(seq 1 60); do
  shot
  if grep -q "engine listening" "$data/engine.log" 2>/dev/null; then ok=1; break; fi
  sleep 1
done
film 8

echo "== start trace"; cat "${TMPDIR:-/tmp}/sinnect-start.log" 2>/dev/null | sed 's/^/  /' || echo "  none"
echo "== engine.log"; head -30 "$data/engine.log" 2>/dev/null | sed 's/^/  /' || echo "  none"
echo "== processes"; ps ax -o pid,comm | grep -iE 'sinnect|/node' | grep -v grep | sed 's/^/  /'
app_up=$(pgrep -f "$exe" >/dev/null && echo 1 || echo 0)
osascript -e 'quit app "Sinnect"' 2>/dev/null || true
sleep 2; pkill -f "Sinnect.app/Contents/MacOS/" 2>/dev/null || true

[ "$app_up" = 1 ] || { echo "::error::Sinnect did not start"; exit 1; }
[ "$ok" = 1 ] || { echo "::error::The engine did not start"; exit 1; }
echo "Sinnect and its engine started fine"
