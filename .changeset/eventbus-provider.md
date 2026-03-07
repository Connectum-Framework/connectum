---
"@connectum/events": minor
"@connectum/events-nats": minor
"@connectum/events-kafka": minor
"@connectum/events-redis": minor
"@connectum/core": minor
---

Add EventBus provider with pluggable broker adapters (NATS JetStream, Kafka/Redpanda, Redis Streams).

**New packages:**
- `@connectum/events` — Universal event adapter layer with proto-first pub/sub, middleware pipeline, DLQ
- `@connectum/events-nats` — NATS JetStream adapter with durable consumers
- `@connectum/events-kafka` — Kafka/Redpanda adapter with consumer groups
- `@connectum/events-redis` — Redis Streams adapter with XREADGROUP

**Core integration:**
- `EventBusLike` interface for server lifecycle integration
- `createServer({ eventBus })` option with automatic start/stop management
