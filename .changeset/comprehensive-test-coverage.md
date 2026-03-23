---
"@connectum/core": patch
"@connectum/auth": patch
"@connectum/cli": patch
"@connectum/interceptors": patch
"@connectum/events": patch
"@connectum/healthcheck": patch
"@connectum/reflection": patch
"@connectum/events-nats": patch
"@connectum/events-kafka": patch
"@connectum/events-amqp": patch
---

Comprehensive test coverage improvements across 10 packages (+225 tests).

**New test files:**
- `core/envSchema.test.ts` — env config validation (50 tests)
- `core/server-lifecycle.test.ts` — server integration with eventBus, protocols, shutdown (24 tests)
- `auth/errors.test.ts` — AuthzDeniedError (14 tests)
- `auth/authz-utils.test.ts` — satisfiesRequirements() (12 tests)
- `cli/proto-sync.test.ts` — CLI unit tests (33 tests, was 4 integration-only)
- `events/topic.test.ts` — resolveTopicName() (3 tests)
- `healthcheck/healthcheck-grpc.test.ts` — gRPC Health Check + HTTP E2E (11 tests)

**Extended existing tests:**
- `core` — Server state transitions, ShutdownManager deps/cycles, graceful shutdown edge cases (+17)
- `healthcheck` — gRPC handlers, manager merge, HTTP handler scenarios (+17)
- `reflection` — circular deps, empty registry, multiple services (+6)
- `interceptors` — error handler, timeout, retry, bulkhead, fallback, defaults (+20)
- `events-nats/kafka/amqp` — adapter utility functions (+15)
