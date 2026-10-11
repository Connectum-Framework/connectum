---
"@connectum/events-amqp": minor
---

fix: align AMQP topic subscriptions with EventBus wildcard matching

**BREAKING** behavior correction. On topic exchanges, terminal `>` now requires
at least one trailing routing-key segment. The adapter translates `user.>` to
`user.*.#` instead of `user.#`, rejects a complete `>` token outside the
terminal position, and rejects a complete `*` or `>` segment on a **direct**
exchange when the adapter creates the binding itself (`topologyMode: "assert"`):
such a binding is a literal key and the queue would never receive a message.
With `topologyMode: "check"` or `"skip"` the operator's bindings decide, so no
pattern is rejected. Fanout and headers exchanges are unchanged: the queue
receives every message whatever the pattern, and the EventBus dispatches only
matching handlers. Topic-exchange subscriptions containing a complete `#`
segment are also rejected because RabbitMQ would interpret it as a wildcard
while the common EventBus matcher treats it as literal text. Characters
embedded in a segment remain literal. Explicit raw topology bindings using `#`
and `#` routing-key literals on non-topic exchanges retain their
broker-specific behavior.

`FakeAmqpAdapter` accepts `exchangeType` and `topologyMode`, validates patterns
exactly like the real adapter, and routes `deliver()` by exchange type (fanout
and headers reach every subscription).

This is a breaking behavior correction released with the coordinated 1.3 package
group, consistent with the project's recorded 1.3 exception for breaking
changes. Existing broad bindings such as `user.#` are not removed automatically;
operators must inspect and replace them with `user.*.#` while preserving queues
and queued messages. See the AMQP migration guide.
