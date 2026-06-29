---
"@connectum/events-amqp": patch
---

docs(events-amqp): document republish-safety and recovery semantics

- The Error Taxonomy now publishes an authoritative **Message state** / **Republish (at-least-once)** matrix (README + the errors `@module` JSDoc) so at-least-once producers no longer infer retry-safety from class names. Connection loss is classified structurally and is never misreported as a nack; `AmqpSerializationError`/`AmqpUnroutableError`/`AmqpTopologyError` are documented as deterministic (do-not-republish).
- Recovery docs clarify that `maxRetries` governs **both** the initial connect and every steady-state recovery series (counter reset on success), with the brittleness of a finite value, and that the effective reconnect delay can overshoot `maxDelay` because of equal-jitter.
- `topologyMode: "check"` and the recovery JSDoc are finalized: fail-fast applies only with `recovery: false` or `failFastOnInitialSetupError: true`; under the default recovery a permanent setup error is surfaced via `onSetupFailed` / `onReconnecting`.
