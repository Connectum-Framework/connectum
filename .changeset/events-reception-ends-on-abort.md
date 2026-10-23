---
"@connectum/events": minor
---

fix: the event bus stops receiving when the shutdown signal aborts. Under `createServer()` the server aborts its signal first and the bus is stopped by a shutdown hook afterwards (up to `shutdown.timeout` later); in between, a delivery used to start a handler whose `ctx.signal` was already aborted, the retry middleware does not retry after a cancellation, and a transient failure was dead-lettered when a dead-letter queue was configured. Now the bus ends its subscriptions at the abort and returns every delivery that still arrives to the broker with a requeue, so it is handled after the restart or by another consumer. Handlers that are running are not touched: they finish, can still publish through `ctx.publish`, and `stop()` drains them and disconnects as before. The subscriptions are ended once whichever of the abort and `stop()` comes first.

**BREAKING (behaviour):** for every service that passes an `eventBus` to `createServer()`, a message that arrives between the server abort and the bus hook is no longer handled; it is redelivered. A bus started by hand with a signal (`start({ signal })` or the `signal` option) receives nothing once that signal aborts, and a bus started with an already aborted signal subscribes and ends its subscriptions at once; call `stop()` to release it. Publishing through the bus keeps working until `stop()`.
