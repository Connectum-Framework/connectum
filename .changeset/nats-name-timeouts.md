---
"@connectum/events-nats": patch
---

fix: a connect, publish or subscribe that times out says what it was doing. The NATS client reports every unanswered request as `TimeoutError: timeout` (after 20 s for the connection, 5 s for a JetStream request), which names neither the topic nor the servers. The message now starts with the action: `NatsAdapter: connect to <servers> did not complete in time: timeout`, `NatsAdapter: publish to topic "<topic>" on stream "<stream>" was not acknowledged in time: timeout`, `NatsAdapter: subscribe to topics [...] on stream "<stream>" did not complete in time: timeout`. The error keeps its class, `name` and `cause`; the original text stays at the end; a topic longer than 100 characters is cut and its length given. Other errors are unchanged.
