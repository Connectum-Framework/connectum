---
"@connectum/events-kafka": minor
---

feat: `KafkaAdapter()` validates its options when it is called and throws an error that names the option and the received value. `options` must be an object; `brokers` a non-empty array of non-empty strings; `clientId` a non-empty string; `consumerOptions.sessionTimeout` a finite number above the 3000 ms heartbeat interval; `retry.retries` a non-negative integer and the other `retry` fields non-negative finite numbers; `sasl.mechanism` one of `plain`, `scram-sha-256`, `scram-sha-512`, `oauthbearer`, `aws` (a mechanism the client library supports only through `clientOptions` stays there). Previously `KafkaAdapter(undefined)` failed with `Cannot use 'in' operator`, and the other values were accepted and surfaced later (`brokers: []` at `connect()`, a too-small `sessionTimeout` at the first `subscribe()`, an invalid `retries` as an endless or immediate retry) with a message that did not name the option. Valid values behave as before.
