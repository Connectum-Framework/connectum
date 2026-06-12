---
"@connectum/events-amqp": minor
---

External AMQP contracts, automatic recovery, and reliable per-message publishing.

The adapter can now implement an externally agreed AMQP contract (AsyncAPI-style) and survive broker outages:

- **Serialization**: `serialization: { contentType, encode, decode }` — set the message `contentType` (e.g. `application/json` for JSON contracts; default stays `application/protobuf`) and optionally transcode the wire body.
- **Explicit topology**: `topology: { exchanges, queues, bindings }` with arbitrary external names and raw AMQP `arguments` (incl. `x-dead-letter-exchange`), exchange-to-exchange bindings, plus `topologyMode: "assert" | "check" | "skip"` for app-owned topology with fail-fast existence checks.
- **queueOverrides**: attach a consumer group to an externally named queue instead of `${exchange}.${group}`.
- **Automatic recovery** (amqplib v2 native opt-in recovery, enabled by default): reconnect with backoff/jitter, re-created channels, re-applied topology, replayed subscriptions. `lifecycle` callbacks (`onConnected` / `onDisconnected` / `onReconnecting` / `onReconnectFailed`) replace console-only error reporting. With recovery enabled `connect()` waits for the broker (docker-compose friendly); `recovery: false` restores fail-fast.
- **Reliable publishing**: every `publish()` resolves on its own broker ack and rejects with a typed error — `AmqpUnroutableError` (mandatory + `basic.return`, correlated via a private `x-connectum-publish-id` header; opt-out `correlationHeader: false` switches to single-flight), `AmqpPublishNackError`, `AmqpPublishTimeoutError` (`publishTimeoutMs`, default 30 s), `AmqpConnectionError`, `AmqpTopologyError`, `AmqpSerializationError`.

Deprecations / behavioral notes:

- The `sync` publish flag is now a no-op in this adapter — confirms are always per-message.
- `mandatory: true` publishes stamp the `x-connectum-publish-id` header on the wire (visible to external consumers; documented; opt-out available).
- Dependency: `amqplib` upgraded `^1.0.3` → `^2.0.1`.
