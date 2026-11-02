---
"@connectum/core": minor
---

feat: `createServer({ logger })` routes the messages the server writes about its own lifecycle (the listening address, a received shutdown signal, a shutdown timeout, a failed graceful close, a lifecycle listener that threw, transport warnings) to your logger. The logger is an object with `info`, `warn` and `error` functions; `createServer()` throws a `TypeError` naming the option for anything else. Without the option the messages still go to `console`, exactly as before. The new `ServerLogger` type is exported.

A shutdown hook that depends on a name nobody registered (`server.onShutdown("api", ["db"], fn)` with no `db` hook) is no longer silent: the hook still runs, and one warning per missing name goes to the logger when the server stops. Names are checked at shutdown, so a dependency registered after the hook that names it does not warn.
