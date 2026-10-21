---
"@connectum/events-redis": patch
"@connectum/events-amqp": patch
---

fix: a handler that is still running when `unsubscribe()` is called can now acknowledge its message. `EventBus.stop()` unsubscribes first and waits for the handlers afterwards, and both adapters tore down the acknowledgement path at that moment: `RedisAdapter` closed the blocking connection that also carried `XACK` (the acknowledgement failed with `Connection is closed.` and the entry stayed pending until it was reclaimed 30 seconds later), and `AmqpAdapter` closed the consumer channel (the acknowledgement was skipped, the broker took the message back and delivered it again to a consumer of the same group). The Redis adapter now acknowledges on its shared connection, which stays open until `disconnect()`; the AMQP adapter cancels the consumer at once but closes its channel when the last handler of that subscription has finished, without making `unsubscribe()` wait for a slow handler. Measured against a real Redis 6.2 and a real RabbitMQ 4.3.6 before the change (the acknowledgement error, the redelivery to a second consumer of a named group) and after it.
