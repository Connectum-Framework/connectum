---
"@connectum/events-amqp": patch
---

docs: state which RabbitMQ versions the integration suites ran on instead of the untested ">=3.8" (every suite on 4.3.6; the consumer-timeout suite also on 3.13.7, 4.1.8 and 4.2.8), document how `consumer_timeout` ends a consumer (a cancel on the 4.3 releases that were run, a channel close on the earlier lines), and give a local-broker command that boots reliably.
