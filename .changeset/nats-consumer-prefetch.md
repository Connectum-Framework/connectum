---
"@connectum/events-nats": minor
---

feat: add `consumerOptions.prefetch`, the number of messages the server may hand to one consumer ahead of its handler. The server starts the `ackWait` timer of a message when it delivers the message to the client's buffer, and the handler runs one message at a time, so with the client's default buffer of 100 a single consumer received duplicates as soon as `handler time x buffer position` outgrew `ackWait` (measured on JetStream 2.11 with `ackWait: 1500`: 8 messages of 400 ms each arrived 13 times; with `prefetch: 1` they arrive 8 times). The default is unchanged (the client's own buffer of 100); set a small `prefetch` for handlers that take long compared with `ackWait / 100`. An integer from 1 to 2147483647 is accepted, anything else makes `NatsAdapter()` throw.
