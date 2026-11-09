# Features

[← Back to the README](../README.md)

## The canvas

- **Pan, zoom, box-select, minimap.** Right-click or press `Tab` to start a session. Zoomed far out, cards turn into small pills so huge boards stay smooth.
- **Live cards.** Each session shows what it's doing right now, its status, tokens used and cost. Double-click to morph it open into the full conversation, tool calls, files, token breakdown and messages.
- **Families.** Colored frames for sessions working on the same topic. Drag a card in or out to change membership; moving the frame moves its sessions.
- **Command palette.** `Ctrl+F` to search sessions, jump to the ones that need you, spawn sessions or families, open workspaces and more.
- **Workspaces.** Save and load whole boards. Autosaves every few seconds. Saved sessions come back with a **Resume** button.
- **Templates.** Save a session setup (model, prompt, priority, permissions, family) and spawn it again in one click.
- **Notifications.** A desktop notification when a session finishes, errors or needs you while Sinnect is in the background.

## Sessions working together

- **Connections.** Drag from one card to another. Connected sessions can message each other, and a light travels along the line when they do.
- **Who knows who.** Before starting a session you pick whether it works alone, knows its family, or knows everyone on the board.
- **File coordination.** Every edit claims the file first. Higher priority wins on its own. Sessions with equal priority negotiate (yield or insist, max 2 rounds), and if they can't agree, you decide.
- **Dynamic island.** Permission requests and questions drop down from the top of the window. Several at once stack up with arrows.

## Memory that learns

When a session that did real work stops, it writes down a few short lessons (repo rules, what worked, what broke) and reusable skills as plain markdown. New sessions only load the handful that match their folder and task. A card shows "Sinnect learned N things" so you can keep or delete them. Point the memory folder at your Obsidian vault to read and edit them there.

## Helpers (boss and workers)

A session can hand side jobs to helper sessions that pop out of its card, wired to it, and run in parallel on a model that fits the job (a fast model for search, reading and tests, a stronger one for code and planning, all editable in Settings). Each helper sends back one short summary and fades out when done, unless you pin it. Max 4 helpers per session, no helpers-of-helpers, and a spend cap shown live on the boss card.

## Three model providers

Claude, ChatGPT/OpenAI and Gemini sessions all sit on the same canvas, use the same wires, messages, file claims and permission prompts, and can talk to each other. Tap the pill at the top to see your Claude and ChatGPT plan limits (5-hour and weekly). Setup for each is in [Install and sign in](install.md).

## Token-cheap by design

The coordination layer (the Hub) runs in plain code inside the app and costs zero tokens. Sessions never see each other's transcripts. They get one-line summaries, short capped messages, and a notice only when something actually concerns them (a file they want, a message sent to them). Messages don't wake the other session up unless you allow it, and there are hard caps on wake chains and wakes per hour. Status lines on cards are built from tool calls, not from asking the model to summarise.

## First-run guide

A short animated guide on first launch walks through signing in, memory (with the optional Obsidian vault), helpers and shortcuts. Open it again from `Ctrl+F`.
