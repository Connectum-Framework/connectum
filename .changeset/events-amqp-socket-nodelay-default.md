---
"@connectum/events-amqp": patch
---

fix: the AMQP adapter turns Nagle's algorithm off on its connections (`noDelay: true`) unless `socketOptions.noDelay` says otherwise. amqplib leaves it on by default, and with it on a `publish()` that starts right after the previous message was delivered to a consumer on the same connection waited about 40 ms for an acknowledgement: measured against RabbitMQ 4.3.6, the median of such a `publish()` was 43.9 ms with the default and 0.4 ms with `noDelay: true` (three alternating runs each, 500 measured calls, every publication confirmed). A plain sequence of publishes without a consumer, and 16 parallel publishers, showed no distinguishable difference. The RabbitMQ server itself turns Nagle off for client connections by default. The option applies to both connections of the adapter (the working connection and the startup probe). To keep amqplib's behaviour, pass `socketOptions: { noDelay: false }`.
