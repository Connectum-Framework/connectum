---
"@connectum/events-amqp": minor
---

fix: `AmqpAdapter()` rejects a `topologyMode` other than `"assert"`, `"check"` or `"skip"` with a `TypeError` that lists the allowed values. Any other value (`"CHECK"`, `"Skip"`, a typo, `null`, `""`, a number) used to be treated as `"assert"`, so an operator who meant `check` or `skip` got the exchange and queues declared by the service. A configuration that relied on such a value now fails at start-up: use the exact lower-case mode name.
