---
"@connectum/events-amqp": patch
---

docs: state the RabbitMQ versions the integration suites pass on (3.13.7, 4.1.8, 4.2.8, 4.3.6) instead of the untested ">=3.8", document how `consumer_timeout` ends a consumer on each broker line (cancel on 4.3, channel close before), and give a local-broker command that boots reliably.
