---
"@connectum/core": minor
---

fix(core)!: `server.stop()` aborts in-process calls like HTTP calls

**BREAKING (behaviour):** in-flight in-process calls — `server.localClient()`, `server.client()` for a local service, `createLocalTransport()`, and `ctx.call` / `ctx.stream` to a local service — now have their `context.signal` aborted when `server.stop()` begins, exactly like calls received over HTTP. Previously the in-process router never received the server's shutdown signal, so local handlers, streams and pending request gates kept running unaware of the shutdown.

- A handler, stream or `requestGate` that watches `context.signal` now ends on `stop()` on both transports. A handler that rethrows the abort ends the call with `Code.Canceled`, the same as over HTTP.
- A handler that ignores the signal is not killed. `stop()` does not wait for in-process calls either: they ride no connection, so there is nothing for the timeout race or `forceCloseOnTimeout` to drain or destroy.
- In a `ctx.call` chain, every local hop is aborted directly, not only through the outer call.
- A local call made after `stop()` starts with an already-aborted signal. Before `start()`, the signal is live, as before.
- **Action:** if code relied on local calls finishing undisturbed during shutdown, handle `context.signal` explicitly. For example, finish the work before calling `stop()`, or run it in a shutdown hook.
