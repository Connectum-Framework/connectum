---
"@connectum/events-amqp": patch
---

Harden the connection-loss-vs-nack classification of in-flight publishes. A per-confirm-channel `close` flag (set via `prependListener`, before amqplib drains outstanding confirms) is now the primary structural signal for classifying a failed publish confirm as `AmqpConnectionError` vs `AmqpPublishNackError`; the amqplib error-text match is retained only as a defense-in-depth fallback. This makes the at-least-once republish decision robust to upstream error-text drift. No public API change, and genuine broker nacks on a live channel still classify as `AmqpPublishNackError`.
