---
"@connectum/cli": minor
---

feat: `connectum init`, `connectum proto sync` and `connectum generate service` now refuse a flag they do not define and `connectum init` refuses `--node-exec` together with `--runtime bun`. Before, a mistyped flag was dropped without a word: `init --evnts nats` produced a project without events, and `proto sync --dryrun` ran the real sync instead of the dry run. The refusal is one line, `Error: connectum init: unknown option --evnts. Valid options: ...`, with exit code 1 and nothing written. `--node-exec` used with Bun had no effect (Bun runs TypeScript itself) and now fails with a message naming both flags; leave `--node-exec` out when scaffolding for Bun. Scripts that passed a flag the command never had must drop it.
