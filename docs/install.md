# Install and sign in

[← Back to the README](../README.md)

- [Windows](#windows)
- [Mac (beta)](#mac-beta)
- [Signing in to Claude](#signing-in-to-claude)
- [ChatGPT and OpenAI sessions](#chatgpt-and-openai-sessions)
- [Gemini sessions](#gemini-sessions)
- [Updates](#updates)

## Windows

**[⬇ Download Sinnect-Setup.exe](https://github.com/Suma-Udd/Sinnect/releases/latest/download/Sinnect-Setup.exe)**

1. Open `Sinnect-Setup.exe` and click through the installer. No Node, no terminal, nothing else to install.
2. Windows might say "Windows protected your PC" because the app isn't code-signed yet. Click **More info**, then **Run anyway**.
3. Open Sinnect from the Start menu and sign in (see below).

## Mac (beta)

**[⬇ Apple Silicon (M1 to M4)](https://github.com/Suma-Udd/Sinnect/releases/latest/download/Sinnect-mac-arm64.dmg)** · **[⬇ Intel Mac](https://github.com/Suma-Udd/Sinnect/releases/latest/download/Sinnect-mac-intel.dmg)**

The Mac version is new and hasn't had much real-world testing yet, so expect rough edges and please [open an issue](https://github.com/Suma-Udd/Sinnect/issues/new/choose) if something's off.

1. Open the `.dmg` and drag **Sinnect** into **Applications**.
2. Sinnect isn't signed by Apple yet, so macOS blocks it the first time. Try opening it once, then go to **System Settings > Privacy & Security**, scroll down and click **Open Anyway**. (On older macOS you can also right-click the app > **Open**.)
3. If macOS says the app "is damaged and can't be opened", that's the same block. Run this in Terminal and open it again:
   ```bash
   xattr -dr com.apple.quarantine /Applications/Sinnect.app
   ```
4. Sign in and you're in.

Linux isn't out yet.

## Signing in to Claude

Two modes, switch any time in Settings:

- **My Claude account.** Click **Sign in with Claude** on first launch and follow the window that pops up. Sessions run through Claude Code's own login on your computer and usage comes out of your Claude plan. Anthropic's Agent SDK docs don't allow third-party apps to offer claude.ai login, so treat this mode as personal use at your own risk.
- **API key.** Pay per token with a key from [console.anthropic.com](https://console.anthropic.com). This is the officially supported way.

## ChatGPT and OpenAI sessions

Pick **Runs on: OpenAI** in the new session card. Two ways to sign in (Settings > How OpenAI sessions sign in):

- **My ChatGPT account** (default). Uses your ChatGPT plan through OpenAI's own [Codex](https://developers.openai.com/codex) app, the same way the Codex IDE extension does. Install Codex once (`npm install -g @openai/codex`, or the **Install** button in Settings), then press **Sign in with ChatGPT**. Usage counts against your plan's limits, not a per-token bill, and Sinnect warns you at 80% and 95%.
- **API key.** Paste a key from [platform.openai.com/api-keys](https://platform.openai.com/api-keys); billed per token. Chats are sent with `store: false`, so they stay on your computer.

Every command and file change still goes through Sinnect first, so permission prompts and file claims work the same as for Claude.

## Gemini sessions

Pick **Runs on: Gemini** in the new session card, paste a Gemini API key once (the free one from [aistudio.google.com/apikey](https://aistudio.google.com/apikey) works), and pick a model. The free key has per-minute and per-day limits; when you hit one, the session tells you and you just send again later.

## Updates

Sinnect checks for updates when it opens and every few hours. When a new version is out, a card pops up bottom right: click **Update and restart**. You can also check by hand in Settings or with `Ctrl+F` > Check for updates.

Your settings, keys and saved boards live in `%APPDATA%\Sinnect\` on Windows and `~/.sinnect/` on Mac.
