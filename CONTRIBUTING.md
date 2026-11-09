# Contributing to Sinnect

Thanks for wanting to help! Bug reports, ideas and pull requests are all welcome.

- **Found a bug or have an idea?** [Open an issue](https://github.com/Suma-Udd/Sinnect/issues/new/choose). Screenshots help a lot.
- **Want to send code?** Fork, make a branch, and open a pull request into `main`. Before you push, run:
  ```bash
  npm run typecheck && npm test && npm run build
  ```
- **New to the codebase?** [docs/development.md](docs/development.md) shows how to run it, and [AGENTS.md](AGENTS.md) has the full map of how it's built (handy for you or your AI agent).

A few things we care about:

- It has to look good and feel smooth. If you change something visual, add a before/after screenshot to the PR (demo mode is perfect for this: `npm run demo`).
- Keep sessions token-cheap. Anything that makes sessions chat with each other more needs a good reason.
- Small, focused pull requests get merged faster.
