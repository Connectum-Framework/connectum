---
"@connectum/core": patch
---

fix: `server.stop()` is idempotent, as the shutdown guide always said. A call after the server has stopped now resolves immediately without repeating the shutdown or emitting events, instead of throwing `Cannot stop server: current state is "stopped"`. Concurrent calls during shutdown still join it and settle with its outcome. Calling `stop()` on a server that was never started (or is still starting) still throws, because that is a lifecycle mistake rather than a repeat. Code that relied on the throw after a stop (for example to detect "already stopped") must check `server.state` instead.
