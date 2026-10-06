---
"@connectum/core": patch
"@connectum/testing": patch
---

fix: cancelling an in-process streaming call now finishes the handler's output stream

- Over HTTP/2 a cancelled call unwinds a streaming handler through its `finally`. Over `server.localClient()` / `createLocalTransport()` nothing pulls once the client stops reading, so a handler parked at `yield` kept its `ctx.signal` aborted but never reached its `finally`: cursors, subscriptions and handles opened before the `yield` leaked. The in-process transport now finishes the handler's output iterator when the call's signal aborts (client `AbortSignal`, deadline, `server.stop()`); an abort that arrives while the handler is inside an `await` finishes it right after that step, never concurrently.
- Leaving a `for await` loop with `break` is still not a cancellation on either transport: the handler keeps running until the call is aborted or the server stops.
- `@connectum/testing`: two parity scenarios (abort, and break followed by abort) compare what the handler observes on both transports, not only what the client sees.
