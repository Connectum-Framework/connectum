---
"@connectum/events-amqp": minor
---

fix: a connection lost while the topology setup pass runs is reported as `AmqpConnectionError`, not `AmqpTopologyError`: with `failFastOnInitialSetupError` it no longer rejects `connect()` (the adapter falls through to recovery, as documented), it emits no `setup-failed`, and a bounded initial attempt counts it as a transient failure; also for `recovery: false` the class of that rare error changes. Broker replies (404, 406, 403, …) and the adapter's own configuration check still fail fast under the flag. A connection error raised while the pass runs no longer reaches the process as an unhandled `error` event.
