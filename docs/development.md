# Development

[← Back to the README](../README.md)

Working with an AI coding agent? Point it at [AGENTS.md](../AGENTS.md), it has the full brief.

## Run it

Needs Node 20+ (CI uses 22). For the real desktop window you also need Rust and the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

```bash
npm install

npm run demo                       # free demo mode in the browser: http://127.0.0.1:4317
npm run dev:mock                   # fake engine (terminal 1)
npm run dev:ui                     # UI with hot reload (terminal 2)
npm run app:dev                    # the real Tauri window

npm run typecheck && npm test && npm run build   # what CI runs
```

Build installers yourself:

```bash
npm run app:build                    # Windows: src-tauri/target/release/bundle/nsis
npx tauri build --bundles app,dmg    # Mac: src-tauri/target/release/bundle/dmg
```

Or skip all that: the **Build and release** GitHub Action builds the Windows installer and both Mac apps for you.

## How it's built

| Part | What | Where |
| --- | --- | --- |
| Shell | Tauri 2 (Rust). Opens the window, starts the engine, notifications, updater. | `src-tauri/` |
| Engine | Node process. Runs Claude, OpenAI and Gemini sessions, hosts the Hub, talks to the UI over a local WebSocket. | `packages/engine/` |
| UI | React, React Flow, Motion, Zustand, Tailwind. | `packages/ui/` |

More detail, including a file map, is in [AGENTS.md](../AGENTS.md).

## Releasing

1. Merge the pull request into `main`.
2. Go to **Actions > Build and release > Run workflow** (branch `main`).
3. Type the next version (like `0.2.1`) and a sentence or two of notes. They show up in the app's update popup.
4. About 15 minutes later the release is live and installed apps offer the update.

Leave the version empty for a test build: the files show up on the run and nothing is published.

## Contributing

Pull requests are welcome. See [CONTRIBUTING.md](../CONTRIBUTING.md).
