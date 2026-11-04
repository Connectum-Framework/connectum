---
"@connectum/events-kafka": patch
---

fix: overlapping `connect()` calls on one `KafkaAdapter` share a single connection attempt. Before, each call created its own producer and the one assigned last replaced the others, so the replaced producer's sockets and timers survived `disconnect()` and kept the process from exiting. A failed attempt rejects every overlapping call with the same error and is not remembered; `disconnect()` called while `connect()` is under way waits for it and then closes the connection.
