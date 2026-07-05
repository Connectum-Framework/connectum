---
"@connectum/events": minor
---

feat: `drainPublishTimeout` — opt-in symmetric publish drain on shutdown (#196)

- New `EventBusOptions.drainPublishTimeout`: during `stop()`, wait up to the budget for in-flight `publish()` promises (started before `stop()`) to settle, before the adapter disconnects and would fail their confirms. Bus-level (L1): zero adapter-contract changes — nats/kafka/redis/amqp get the drain for free.
- Runs concurrently with the handler drain (`drainTimeout`) — shutdown waits for the slower of the two budgets, never their sum.
- Tracked promises carry a no-op observer: a publish settling (even rejecting) after the deadline never becomes an `unhandledRejection`; the caller's own `publish()` promise is unaffected.
- Default `undefined` (and `0`/negative) — disabled: `stop()` behavior stays bit-for-bit (pinned by a regression test).
- Documented limitation: publishes issued from draining handlers are not covered — the stopping gate rejects them (relay-pattern design tracked in #212).
