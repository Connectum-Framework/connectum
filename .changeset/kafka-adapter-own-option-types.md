---
"@connectum/events-kafka": minor
---

feat!: the public options of `KafkaAdapter` no longer name the Kafka client library. The published type declarations of `@connectum/events-kafka` used to import `KafkaConfig` and `CompressionTypes` from `kafkajs`, so replacing the client would have been a breaking change of this package even where the adapter's behaviour stays the same. They are now Connectum-owned types.

**BREAKING.**

| Before | From 1.3.0 |
| --- | --- |
| `kafkaConfig: { ssl, sasl, connectionTimeout, authenticationTimeout, reauthenticationThreshold, requestTimeout, enforceRequestTimeout, retry, logLevel }` | the same names as top-level options: `ssl`, `sasl`, `connectionTimeout`, `authenticationTimeout`, `reauthenticationThreshold`, `requestTimeout`, `enforceRequestTimeout`, `retry`, `logLevel` |
| `kafkaConfig: { logLevel: logLevel.ERROR }` (enum) | `logLevel: "error"`; also `"nothing"`, `"warn"`, `"info"`, `"debug"` |
| `kafkaConfig: { sasl: { mechanism: "plain", username, password } }` | `sasl: { mechanism: "plain", username, password }`; `scram-sha-256`, `scram-sha-512`, `oauthbearer` and `aws` keep their fields |
| `kafkaConfig: { logCreator, socketFactory, a custom SASL mechanism, retry.restartOnFailure, TLS options beyond ca/cert/key/passphrase/rejectUnauthorized/servername }` | `clientOptions: { ... }`: the keys of the client library in use, **not portable and not type-checked**, merged shallowly over the typed options; it can never override `brokers` or `clientId` |
| `producerOptions: { compression: CompressionTypes.GZIP }` or `compression: 1` | `producerOptions: { compression: "gzip" }`; also `"none"`, `"snappy"`, `"lz4"`, `"zstd"` |

Passing the old `kafkaConfig` key now throws a `TypeError` that points to the migration page, instead of being ignored: a JavaScript caller would otherwise connect without its TLS and SASL settings. A `compression` that is not one of the five names (including a number) throws a `RangeError`. Snappy, LZ4 and ZSTD still need a codec that the application registers with the client library before the first publish; only gzip works as shipped.

Behaviour of the adapter, its consumer options (`sessionTimeout`, `fromBeginning`, `allowAutoTopicCreation`, `redeliveryDelay`, `commitStrategy`, `topicDiscoveryInterval`) and the broker protocol are unchanged. Released in a minor version, as the other behaviour corrections of 1.3.
