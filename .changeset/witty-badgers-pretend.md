---
"@connectum/events-amqp": minor
---

feat: programmable `FakeAmqpAdapter` test double via `@connectum/events-amqp/testing` (#203)

- New subpath export `@connectum/events-amqp/testing` with `FakeAmqpAdapter` — model AMQP failure semantics in unit tests without a broker: FIFO publish outcomes (`control.nextPublish` with the real typed error classes, incl. `AmqpPublishTimeoutError` — the state-UNKNOWN outcome no real broker reproduces deterministically), deterministic connection lifecycle (`dropConnection`/`completeRecovery`/`exhaustRecovery`/`failSetup`/`block`), wildcard + competing-consumer delivery with a settlement result (`{ delivered, acked, nacked, requeued, failed }`), and a `published` record of bus-facing publishes.
- Parity by construction and by pinning: lifecycle events go through the real adapter's dispatch (canonical union ordering, deprecated flat shim, exception isolation); the state machine mirrors the real adapter (`already connected` from live/recovering/retries-exhausted states; mid-recovery `subscribe()` parks and settles with the recovery outcome; `setup-failed`/fail-fast gate on `AmqpTopologyError` like the real probe); incoming envelope headers honored and stripped like the real consumer; handler rejections swallowed like the real nack-on-error path; `instanceof` holds across the subpath boundary (tsup `splitting: true` — shared error-class chunk, pinned by a dist-level test).
- Runtime-pure: the subpath pulls neither `amqplib` nor `node:test` into the consumer graph (only `@connectum/events` + `node:crypto`).
- Documented divergences: no timing simulation (recovery advances via explicit control calls); settlement is recorded, not broker-driven (re-deliver with `attempt + 1` to model redelivery); no wire-level envelope on `published`; report-and-proceed on a non-fail-fast startup setup failure.
