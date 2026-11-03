---
"@connectum/core": patch
---

fix: a repeated SIGTERM/SIGINT while a server with `autoShutdown` is stopping is now explicit. As before, the second signal ends the process at once, in the middle of the shutdown hooks, because it is the operator's way out of a shutdown that hangs; the server now logs a warning first (`Received SIGTERM again while the server is shutting down; the process is terminated now, without waiting for the remaining shutdown hooks`). When the application or another server has its own listener for the signal, the process is not terminated and the log says so.
