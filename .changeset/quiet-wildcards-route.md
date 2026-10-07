---
"@connectum/events-amqp": minor
---

fix: align AMQP topic subscriptions with EventBus wildcard matching

On topic exchanges, terminal `>` now requires at least one trailing routing-key
segment. The adapter translates `user.>` to `user.*.#` instead of `user.#`,
rejects a complete `>` token outside the terminal position, and rejects complete
`*` or `>` wildcard subscriptions on direct, fanout, and headers exchanges
before creating subscription topology. Topic-exchange subscriptions containing
a complete `#` segment are also rejected because RabbitMQ would interpret it as
a wildcard while the common EventBus matcher treats it as literal text.
Characters embedded in a segment remain literal. Explicit raw topology bindings
using `#` and `#` routing-key literals on non-topic exchanges retain their
broker-specific behavior.

This is a breaking behavior correction released with the coordinated 1.3 package
group, consistent with the project's recorded 1.3 exception for breaking
changes. Existing broad bindings such as `user.#` are not removed automatically;
operators must inspect and replace them with `user.*.#` while preserving queues
and queued messages. See the AMQP migration guide.
