---
"@connectum/core": patch
---

fix: a `start()` that never settles no longer makes a process with `shutdown.autoShutdown` unkillable by signals. The first `SIGTERM` or `SIGINT` during the start is recorded as a request to stop once the start settles and the framework releases its signal handlers, so a repeated signal gets the default action and ends the process, as a repeated signal does while a running server is stopping.
