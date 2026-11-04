---
"@connectum/events-redis": minor
---

fix: `connect()` and `subscribe()` no longer wait forever for a Redis server that accepts the TCP connection and never answers. The wait for a ready connection is bounded by `redisOptions.connectTimeout` (ioredis default 10000 ms), which until now covered only the TCP handshake; on expiry the call rejects with `RedisAdapter: connection not ready within N ms (redisOptions.connectTimeout)` and the half-open client is closed, so `bus.start()` fails instead of hanging. A server that needs longer than `connectTimeout` to become ready (a slow TLS or AUTH handshake) now fails to connect: raise `connectTimeout`, or set it to `0` to remove the deadline.
