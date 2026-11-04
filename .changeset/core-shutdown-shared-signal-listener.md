---
"@connectum/core": patch
---

fix: servers with `shutdown.autoShutdown` now share one process listener per signal instead of adding one per server, so starting eleven or more of them in one process (a test suite, a process hosting several servers) no longer makes Node.js print `MaxListenersExceededWarning` for `SIGTERM` and `SIGINT`. Each server still stops on the signal, and the shared listener is removed when the last server stops. A signal name repeated in `shutdown.signals` no longer leaks a listener.
