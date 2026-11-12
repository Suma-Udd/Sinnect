# AGENTS.md

The brief for AI coding agents (Claude Code, Codex, Gemini CLI, Cursor, and friends) working on Sinnect. Read this first; it should be enough to start working without asking.

## What Sinnect is

A desktop app (Windows, plus a Mac beta) with an infinite n8n-style canvas where every node is a live AI coding session. Sessions can run on Claude, OpenAI (ChatGPT plan via Codex, or API key) or Gemini. You can wire sessions together so they message each other, group them into families, and they coordinate file edits through a zero-token "Hub" so two sessions never edit the same file blindly.

- Repo: `github.com/Suma-Udd/Sinnect`, public, MIT. Default branch `main`.
- The owner doesn't write code. Agents write almost everything, the owner judges by using the app and looking at screenshots.
- **Aesthetics and performance come first.** The UI must feel alive and animated, n8n-like.

## Layout

```
src-tauri/            Tauri 2 shell (Rust)
  src/lib.rs          starts the engine sidecar on a free port with a random token,
                      commands: engine_info, stop_engine_for_update, notify;
                      startup trace in %TEMP%/sinnect-start.log; strips \\?\ paths for Node
  tauri.conf.json     version, bundles (NSIS + dmg), updater endpoint + pubkey, window
  installer/          NSIS header/sidebar art
  icons/, app-icon.png  app icons (app-icon.png is the 1024px source)
packages/engine/      Node engine (TypeScript, bundled with esbuild to dist/engine.mjs)
  src/main.ts         entry: WebSocket server for the UI. Env: SINNECT_PORT (4317),
                      SINNECT_TOKEN ("dev"), SINNECT_DATA, SINNECT_MOCK=1, SINNECT_UI
  src/engine.ts       session lifecycle, settings.json, secrets.json, workspaces,
                      templates, budget, routes UI messages, picks the session class
  src/hub.ts          the Hub: roster, file claims, inboxes, negotiation. Zero tokens.
  src/session.ts      BaseSession + the system prompt addon that explains hub tools,
                      wake logic (wake chain + per-hour caps, batching)
  src/real-session.ts Claude session via @anthropic-ai/claude-agent-sdk query();
                      in-process MCP server "sinnect" with hub/memory/helper tools;
                      PreToolUse hook on Edit|Write|MultiEdit|NotebookEdit = auto file claim;
                      canUseTool = permission prompts
  src/loop-session.ts shared agent loop for providers without an SDK (tools, shell,
                      permissions, saving chats). Used by:
  src/gemini-session.ts  Gemini REST API
  src/openai-session.ts  OpenAI Responses API (API key mode, store: false)
  src/codex-session.ts + codex.ts  "My ChatGPT account": drives the user's local
                      `codex app-server` (JSON-RPC over stdio), hub tools as dynamicTools
  src/claude-usage.ts Claude plan 5h/weekly usage via the Agent SDK (no model call)
  src/memory.ts       self-learning memory: Lessons/*.md, Skills/*.md, index file
  src/workers.ts      boss/helper sessions (spawn_workers), kind routing, caps
  src/templates.ts    session templates (validation + persistence)
  src/auth.ts         "My Claude account" login check + sign-in via bundled claude
  src/mock-session.ts demo mode fake sessions
  src/guard.ts        safety checks: who may connect to the engine, the keys file no session
                      may open, one-line hub text, safe links
  src/protocol.ts     ALL shared types between engine and UI. The UI imports it
                      directly, so keep it free of Node imports.
  test/*.test.ts      node:test suites (hub, workers, memory, providers, token drain...)
  sim/*.ts            simulators (token drain, fake Gemini). Run with npx tsx sim/<file>.ts
packages/ui/          React 18 + Vite UI
  src/App.tsx, store.ts (zustand), engine.ts (WS client), actions.ts, workspace.ts,
  notify.ts, updater.ts, lib.ts, Intro.tsx (opening animation), templates.ts
  src/canvas/         Canvas, SessionNode (compact card), FamilyNode, PulseEdge, WorkerEdge
  src/panels/         SetupCard (new session), ExpandedSession, Toolbar, CommandPalette,
                      SignInCard, UpdateCard, Memory, HelperSettings, OpenAISettings, Onboarding
  src/island/         DynamicIsland (prompts from the top), Usage (plan limits)
scripts/
  prepare-engine.mjs  copies engine bundle + Claude Code binary + Node into src-tauri before build
  set-version.mjs     bumps version in every package.json, tauri.conf.json, Cargo
  latest-json.mjs     writes latest.json for the updater
  windows-smoke.ps1, mac-smoke.sh   CI: install like a user, launch, check engine, record
  demo.mjs            npm run demo
docs/                 user docs (install, features, development), screenshots, logo
.github/workflows/    ci.yml, release.yml ("Build and release")
```

## Commands

```bash
npm install
npm run typecheck && npm test && npm run build   # run all three before every push (CI does the same)
npm run demo              # build + demo mode at http://127.0.0.1:4317, free fake sessions
npm run dev:mock          # engine in demo mode with watch (Unix shell syntax)
npm run dev:ui            # Vite dev server for the UI
npm run app:dev           # real Tauri window (needs Rust + Tauri prerequisites)
```

Cloud/Linux agents can't run the real desktop app or reach most model APIs. Use demo mode in a browser (Playwright, deviceScaleFactor 2) for screenshots and UI checks.

## How the pieces talk

1. Tauri starts the engine (Node sidecar) on a free port with a random token and hands both to the UI via `engine_info`.
2. The UI connects over WebSocket, sends the token first, then exchanges `ClientMsg` / `EngineMsg` (see `protocol.ts`).
3. Each node on the canvas is one session object in the engine. The provider is picked from the model id by `providerOf()`: `gemini*` = Gemini, `gpt-*` / `o<n>` / `codex*` / `chatgpt*` = OpenAI, everything else = Claude.
4. Sessions get Hub tools: `hub_roster`, `hub_set_status`, `hub_send`, `hub_inbox`, `hub_claim`, `hub_release`, `hub_negotiate`. Plus memory tools (`memory_search`, `memory_save`, `skill_get`, `skill_save`) and `spawn_workers` for helpers.

## Rules that matter

**Token cost.** The Hub is the product. Keep inter-session traffic tiny: one-line summaries, capped messages, notices only when something concerns the session. `hub_send` does NOT wake the receiver by default; wake chains and wakes per hour are capped. Never add anything that makes sessions reply to each other automatically (ack ping-pong drained tokens once). `test/token-drain.test.ts` guards this.

**File claims.** Edits through file tools are auto-claimed by the hook. Higher priority wins; equal priority negotiates, max 2 rounds, then the dynamic island asks the user. Shell edits (sed etc.) are not caught, that's a known gap.

**Data on disk.** `%APPDATA%\Sinnect\` on Windows, `~/.sinnect/` elsewhere: `settings.json`, `secrets.json` (API keys, owner-only permissions), `workspaces/`, templates, memory (unless pointed at a vault). Never log or ship keys.

**Security.** Treat everything a model writes as untrusted, it may be repeating a prompt injection.
- The UI never loads anything from the internet because a reply said so: markdown images become links, links never navigate the app window, and the Tauri CSP (`tauri.conf.json`) only allows the app's own files plus the local engine. No inline scripts.
- Text that goes from one session into another's prompt (hub messages, goals, claim reasons) is squashed to one line with `oneLine()`, so it can't pose as a hub notice or as the user.
- No session may open `secrets.json` (`isSecretFile()`). Gemini/OpenAI file tools ask before reading or writing outside the working folder, except on full auto.
- The engine socket only accepts the app window and local pages (`allowedOrigin()`) and the token never goes into a session's environment.
- `test/guard.test.ts` guards all of this.

**Look and feel.**
- Dark charcoal canvas `#161616`, dot grid, accent ember orange `#ff6b4a` (hover `#ff8a6e`). Fonts Geist + Geist Mono, icons lucide.
- No gradients, no purple. Anything that looks like generic AI design gets rejected.
- Everything moves (Motion): glowing working cards, rolling counters (NumberFlow), light along wires, morphing expand. Keep it smooth on huge boards (virtualized feeds, glance mode when zoomed out).
- Names, paths and model text can be any length and may have no spaces: truncate one-liners, use `wrap-anywhere` on free text, and check the 900x600 minimum window.
- When you change visuals, take before/after screenshots in demo mode.
- README uses static screenshots only, no gifs or videos.

**Code style.** TypeScript strict, ES modules, small focused files. Comments explain the why in plain English. Tests use `node:test` + `tsx`. Keep `protocol.ts` the single source of shared types.

## Git and pull requests

- Work on a branch, open a PR into `main`. The owner merges. Don't push to `main`.
- **No AI attribution anywhere**: no `Co-Authored-By` AI trailers, no session links, no "Generated with ..." lines in commits, PR bodies or code. This is a firm rule of the repo.
- Write commit messages and PR descriptions in plain, short English.
- Delete the head branch once its PR is merged, so old branches don't pile up.

## Releasing

Only the owner releases (or an agent when explicitly asked):

1. Merge the PR.
2. Actions > **Build and release** > Run workflow on `main`, with a version (like `0.2.1`) and 1 to 3 sentences of notes (shown in the in-app update popup).
3. The workflow bumps versions (`set-version.mjs`), commits "Release vX", tags, builds the signed Windows installer and both Mac dmgs, smoke-tests them, writes `latest.json`, and publishes the release. About 15 minutes.

Empty version = test build (artifacts only). PRs touching `src-tauri/`, `scripts/`, the workflow or the lockfile get a test build automatically. The updater signing key is the repo secret `TAURI_SIGNING_PRIVATE_KEY`; agents can't read or write it, and must never commit any key.

Release assets: `Sinnect-Setup.exe` (+ `.sig`), `Sinnect-mac-arm64.dmg`, `Sinnect-mac-intel.dmg`, `latest.json`. The README download links point at these names, so don't rename them.

## Known gaps

- Windows exe isn't Authenticode-signed (SmartScreen warning), Mac app isn't notarized.
- Mac build, OpenAI/Codex and Gemini have had little real-world testing.
- Can't change permission mode on a running Claude session.
- Edits done through the shell bypass file claims.
