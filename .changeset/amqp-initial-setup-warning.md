---
"@connectum/events-amqp": minor
---

feat: with default options, a topology setup the broker refuses on the first connect is no longer silent. `connect()` still keeps retrying (a service may start before another one fixes the topology), but the adapter now emits one process warning per distinct broker reply (`code: CONNECTUM_AMQP_TOPOLOGY_SETUP_FAILED`, `AmqpTopologyWarning`) that names the exchange or queue and the reason, for example an existing exchange of another type or a queue declared with other arguments (`406 PRECONDITION_FAILED`), and the options that make `connect()` reject (`failFastOnInitialSetupError`, `recovery.initialConnectMaxRetries`). No warning is emitted when `lifecycle.onLifecycle`, `onSetupFailed`, `failFastOnInitialSetupError` or `initialConnectMaxRetries` already reports the failure, for an unreachable broker, or for a reconnect after the first success.
