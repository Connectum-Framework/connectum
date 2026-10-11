---
"@connectum/events-redis": patch
---

docs: the README states that `*` and `>` patterns are rejected when the subscription is made (`RedisAdapter: wildcard pattern "..." is not supported. Redis Streams requires explicit topic names.`), and an integration test now pins that behaviour against a real broker.
