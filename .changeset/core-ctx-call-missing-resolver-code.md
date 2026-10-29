---
"@connectum/core": minor
---

fix: `ctx.call` and `ctx.stream` to a catalog service that is not mounted locally, on a server with no `remoteResolver`, now fail with `FailedPrecondition` and the message `server.client()` already gives ("not mounted locally and no remoteResolver is configured"), instead of `Unavailable` with "the resolver returned null". That is a wiring mistake, and `Unavailable` is the code the `retry` interceptor retries by default, so it was retried as if the service were down. **Behaviour change:** code that matched `Unavailable` for this case (a server without `remoteResolver`) now sees `FailedPrecondition`. A configured `remoteResolver` that returns `null` still gives `Unavailable`.
