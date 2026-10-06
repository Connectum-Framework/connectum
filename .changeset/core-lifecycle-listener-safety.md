---
"@connectum/core": patch
---

fix: a throwing lifecycle listener no longer leaves the server half-started or stuck.

- A `start` or `ready` listener that throws is a startup failure: `start()` rejects with that exception, the bound port, the `autoShutdown` signal handlers and the event bus are released, and the server ends up `stopped` (it used to keep the port and the handlers, or stay in `starting`).
- A `stopping` or `stop` listener that throws is isolated: the remaining listeners still run, the shutdown always reaches `stopped`, and the exception is reported through `error` (printed with `console.error` when nothing listens). It used to leave the server in `stopping` forever.
- A failed shutdown now ends with `stop` after `error` (`stopping → error → stop`, as the lifecycle guide documents) and `stop()` still rejects with the original error.
- A failed signal-initiated shutdown is reported once and can no longer surface as an unhandled rejection.
