---
"@connectum/events-amqp": minor
---

feat: add `consumerOptions.redeliveryDelay`, an opt-in pause between a handler failure and the requeue of the message. A raw handler that always throws is requeued with `nack(requeue=true)` at once, so the broker redelivers it as fast as it can (about 24,000 times in 3 seconds against RabbitMQ 4.3.6), which keeps a CPU core busy and floods the logs. With `redeliveryDelay: 1000` the message is held unacknowledged for one second after each failure. The default is unchanged (`0`, requeue at once). The held message occupies one `prefetch` slot for the delay; the wait ends early when the channel closes, and a message the handler already settled is not delayed. A value outside `0` to `2147483647` makes `AmqpAdapter()` throw. A delay does not replace the `retry` and `dlq` middleware for a message that can never succeed.
