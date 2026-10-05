---
"@connectum/events-amqp": patch
---

fix: a subscription without `group` works on RabbitMQ 4.3 and later

- The private queue `{exchange}.sub-{uuid}` of a subscription without `group` is now exclusive to the subscriber's connection by default. RabbitMQ 4.3 refuses a queue that is neither durable nor exclusive (the `transient_nonexcl_queues` deprecated feature), so the subscription previously failed with a closed channel. The README already described the queue as exclusive.
- `consumerOptions.exclusive` now defaults to `true` and is documented for what it controls: the exclusivity of that private queue. Set it to `false` only for brokers older than 4.3. Subscriptions with `group` are unaffected.
