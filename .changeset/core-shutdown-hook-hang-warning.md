---
"@connectum/core": patch
---

fix: a shutdown hook that outlives `shutdown.timeout` is no longer silent. `shutdown.timeout` still bounds only the connection drain and `stop()` still waits for every hook, but once the timeout has elapsed and hooks are still running the server logs one warning through its `logger` that names the running hooks (an anonymous hook as `anonymous hook #N`) and the elapsed time. When the drain itself used up the timeout, the hooks get the same budget from their own start before the warning. Nothing changes for a shutdown whose hooks finish in time.
