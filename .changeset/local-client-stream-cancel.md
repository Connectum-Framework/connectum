---
"@connectum/core": patch
"@connectum/testing": patch
---

fix: cancelling a streaming call now finishes the handler's output stream on every transport and runtime

- A streaming handler parked at `yield` only unwinds when something pulls its generator again. Over `server.localClient()` / `createLocalTransport()` nothing pulls once the client stops reading, so the handler kept an aborted `ctx.signal` but never reached its `finally`: cursors, subscriptions and handles opened before the `yield` leaked. Over HTTP/2 the server pumps the generator into the socket, but whether a cancelled call is noticed there depends on the runtime: on Node 26.10.0 and under Bun the handler stayed parked as well. Both paths now finish the handler's output iterator when the call's signal aborts (client `AbortSignal`, deadline, `server.stop()`); an abort that arrives while the handler is inside an `await` finishes it right after that step, never concurrently.
- Leaving a `for await` loop with `break` is still not a cancellation on either transport: the handler keeps running until the call is aborted or the server stops.
- `@connectum/testing`: two parity scenarios (abort, and break followed by abort) compare what the handler observes on both transports, not only what the client sees.
