<div align="center">

<img src="docs/assets/logo.svg" width="84" alt="Sinnect logo" />

# Sinnect

**An infinite canvas for your AI coding sessions.**

Run Claude, ChatGPT and Gemini sessions side by side, watch them work live,<br />
and wire them together so they share what they're doing.

<a href="https://github.com/Suma-Udd/Sinnect/releases/latest/download/Sinnect-Setup.exe"><img src="https://img.shields.io/badge/Download_for_Windows-ff6b4a?style=for-the-badge" alt="Download for Windows" /></a>
&nbsp;
<a href="https://github.com/Suma-Udd/Sinnect/releases/latest/download/Sinnect-mac-arm64.dmg"><img src="https://img.shields.io/badge/Mac_%28Apple_Silicon%29-2a2a2a?style=for-the-badge&logo=apple&logoColor=white" alt="Download for Apple Silicon Mac" /></a>
&nbsp;
<a href="https://github.com/Suma-Udd/Sinnect/releases/latest/download/Sinnect-mac-intel.dmg"><img src="https://img.shields.io/badge/Mac_%28Intel%29-2a2a2a?style=for-the-badge&logo=apple&logoColor=white" alt="Download for Intel Mac" /></a>

[![Latest release](https://img.shields.io/github/v/release/Suma-Udd/Sinnect?color=ff6b4a&label=release)](https://github.com/Suma-Udd/Sinnect/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/Suma-Udd/Sinnect/total?color=2a2a2a)](https://github.com/Suma-Udd/Sinnect/releases)
[![CI](https://github.com/Suma-Udd/Sinnect/actions/workflows/ci.yml/badge.svg)](https://github.com/Suma-Udd/Sinnect/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-2a2a2a)](LICENSE)

<br />

<img src="docs/screenshots/board.png" alt="Sessions working together on the Sinnect canvas" />

</div>

<br />

## What you get

<table>
  <tr>
    <td width="34%">🗺️ <b>A canvas, like n8n</b></td>
    <td>Pan, zoom, and drop as many sessions as you want. Group them into colored families.</td>
  </tr>
  <tr>
    <td width="34%">👀 <b>Watch them live</b></td>
    <td>Every card shows what it's doing right now and what it costs. Double-click to open the full conversation.</td>
  </tr>
  <tr>
    <td width="34%">🔌 <b>Wire them together</b></td>
    <td>Drag a line between two cards and those sessions can message each other.</td>
  </tr>
  <tr>
    <td width="34%">🤝 <b>No file fights</b></td>
    <td>Sessions claim a file before editing it. Higher priority wins, ties get negotiated, and if they still can't agree, you decide.</td>
  </tr>
  <tr>
    <td width="34%">🧠 <b>Memory that learns</b></td>
    <td>Sessions write down short lessons and skills as markdown, so the next one starts smarter. Works with Obsidian.</td>
  </tr>
  <tr>
    <td width="34%">🧑‍🔧 <b>Helpers</b></td>
    <td>A session can send side jobs to cheaper helper sessions that run in parallel and report back.</td>
  </tr>
  <tr>
    <td width="34%">💸 <b>Token-cheap</b></td>
    <td>The coordination runs in plain code and costs zero tokens. Sessions only ever see short summaries of each other.</td>
  </tr>
</table>

<table>
  <tr>
    <td width="33%"><img src="docs/screenshots/expanded.png" alt="An opened session" /></td>
    <td width="33%"><img src="docs/screenshots/island.png" alt="A question dropping in from the top" /></td>
    <td width="33%"><img src="docs/screenshots/limits.png" alt="Plan limits for Claude and ChatGPT" /></td>
  </tr>
  <tr>
    <td align="center"><sub>Open a session to see everything</sub></td>
    <td align="center"><sub>Questions drop in from the top</sub></td>
    <td align="center"><sub>Keep an eye on your plan limits</sub></td>
  </tr>
</table>

## Get started

1. **Download** the installer above and open it. If Windows says "Windows protected your PC", click **More info** then **Run anyway** (the app isn't code-signed yet).
2. **Sign in** with your Claude account, or paste an API key. You can add ChatGPT or Gemini later in Settings.
3. **Press `Tab`** (or right-click the canvas) to start a session. Drag from one card to another to connect them.

That's it. Sinnect updates itself from inside the app.

> On a Mac? The Mac build is a fresh beta and needs one extra click to open the first time. See the [Mac steps](docs/install.md#mac-beta).

## Try it for free

Demo mode runs fake sessions in your browser so you can play with the canvas without spending anything:

```bash
npm install && npm run demo   # then open http://127.0.0.1:4317
```

## Learn more

- 📦 [Install and sign in](docs/install.md): Windows, Mac, Claude, ChatGPT and Gemini
- ✨ [All features](docs/features.md): everything Sinnect can do, in detail
- 🛠️ [Development](docs/development.md): build it yourself, how it's made, how releases work
- 🤖 [AGENTS.md](AGENTS.md): the full brief for AI coding agents working on this repo

## License

[MIT](LICENSE). Not affiliated with Anthropic, OpenAI or Google.
