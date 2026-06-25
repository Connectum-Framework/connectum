---
"@connectum/events-amqp": minor
---

Add opt-in `failFastOnInitialSetupError` and an `onSetupFailed` lifecycle callback.

When recovery is enabled, a deterministic setup/topology error on the **first** connect can now reject `connect()` with the typed `AmqpTopologyError` instead of hanging forever in amqplib's infinite recovery loop (under the default `maxRetries: Infinity`, amqplib never rejects the initial connect, so a permanent topology error previously hung `connect()`/`bus.start()` silently). A transient broker-unreachable at startup still blocks-and-retries. `onSetupFailed(error, { initial, attempt })` surfaces setup/topology failures on the initial validation probe and on every reconnect — distinct from a mere broker outage. Default behavior is unchanged (both are opt-in). Also corrects the `topologyMode: "check"` documentation, which previously promised unconditional "fail fast".
