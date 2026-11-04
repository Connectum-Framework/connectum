---
"@connectum/core": minor
---

fix: `createServer()` now validates `shutdown.signals` and `shutdown.autoShutdown` at creation. `autoShutdown` must be a boolean; `signals` must be a non-empty array of signal names the platform knows (not `SIGKILL` or `SIGSTOP`, which a process cannot handle). Before, an unknown name, an empty list or a string left no handler installed, so SIGTERM ended the process without running the shutdown hooks. The error names the option, and for an unknown signal the signal. Valid values behave as before.
