---
"@connectum/reflection": patch
---

fix: `server.stop()` no longer waits out `shutdown.timeout` for a client that keeps a `ServerReflectionInfo` stream open (grpcurl in interactive mode, an IDE plugin, Postman). The handlers of both protocol versions now watch the call's abort signal and end the stream when it aborts, as `Health.Watch` does; before, they stayed parked on the next request of the client, `stop()` returned only after the timeout (30 seconds by default) and logged `Shutdown timeout exceeded`. The client sees the stream end normally.
