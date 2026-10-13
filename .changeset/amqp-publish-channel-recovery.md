---
"@connectum/events-amqp": minor
---

fix: publishing resumes after the broker closes only the publish channel. A publish to a missing exchange under `topologyMode: "skip"` (reply `404`), a `406`, or any other channel-level reply closes just that channel while the connection stays up. Connection recovery never touched it, so every later `publish()` failed with `AmqpConnectionError` until the next full reconnect. The next `publish()` now opens a new confirm channel on the same connection (once, however many publishes are waiting), without a reconnect and without declaring the topology again. A close that carries no broker reply code (a connection loss, `disconnect()`) is still left to connection recovery.

Two lifecycle events report it: `publish-channel-lost { error }` (the broker reply, with its `code`) and `publish-channel-restored`, both union-only, with no flat callback. The publish that caused the close, and the publishes that were in flight on that channel, still reject with `AmqpConnectionError` whose `cause` is the broker reply.

Behaviour change for `publishRetry`: a publish refused by a broker channel close is never retried, even after the channel was recreated; before, the rule held only while the closed channel was still the current one. A connection loss without a broker reply stays retriable.
