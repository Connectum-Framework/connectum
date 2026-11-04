---
"@connectum/events-amqp": minor
---

fix: `FakeAmqpAdapter` (`@connectum/events-amqp/testing`) rejects the same `exchangeType` and `topologyMode` values as `AmqpAdapter()`, with the same `TypeError`. A test that passed `topologyMode: "CHECK"` or `exchangeType: "TOPIC"` to the fake used to pass and then throw against the real adapter. Fix the value in the test.
