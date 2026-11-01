---
"@connectum/core": minor
---

fix: a server-streaming or bidirectional in-process call made after `server.stop()` has begun (inside a shutdown hook, or after `stop()` returned) used to finish with zero messages and no error, without running the handler, so a shutdown hook reading through `server.localClient()`, `server.client()` or `createLocalTransport()` took the empty list for a real answer. Such a call now fails on its first read with `unavailable` (`the server is shutting down`) and the handler body does not start. Unary and client-streaming calls are unchanged and still run with the aborted signal. A caller that treated the empty successful stream as an answer now sees `unavailable`.
