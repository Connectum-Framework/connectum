---
"@connectum/events-amqp": patch
---

fix: when the broker answers a queue declaration or a subscription binding by closing the connection, the `AmqpTopologyError` from `subscribe()` now carries the broker's reply. Before, the message said only `Channel ended, no reply will be forthcoming`. Now it reads, for example, `Failed to declare queue 'x.qg': Connection closed: 541 (INTERNAL-ERROR) with message "INTERNAL_ERROR - Feature transient_nonexcl_queues is deprecated..."`, and `error.cause` is the close reason with its numeric `code`. This is the case of `queueOptions: { durable: false }` for a named group on RabbitMQ 4.3 and later. A refusal that arrives as a channel exception, with its own reply code, is unchanged.
