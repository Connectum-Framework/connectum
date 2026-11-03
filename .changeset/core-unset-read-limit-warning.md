---
"@connectum/core": minor
"@connectum/testing": patch
---

feat(core): `createServer()` writes one warning through the server logger when `readMaxBytes` is not set. Without it incoming messages are limited only by the transport's cap of 4294967295 bytes (about 4 GiB), and an authentication interceptor runs after the message has been received, so one oversized request can exhaust memory. The default is unchanged. Set `readMaxBytes` to the largest message your services accept to remove the warning (any valid value counts, including 4294967295), or pass a `logger` that drops it. The test servers of `@connectum/testing` (`createTestServer`, `createMockContext` and the parity harness) run with the same transport cap set explicitly, so they do not print the warning.
