---
"@connectum/events": minor
"@connectum/events-kafka": minor
"@connectum/events-nats": minor
"@connectum/events-redis": minor
---

feat: auto-derive broker client identity from proto service names

EventBus now automatically derives a service identifier from registered proto
service descriptors (`DescService.typeName`) and passes it to adapters via
the new `AdapterContext` parameter in `connect()`.

Format: `{packageNames}@{hostname}` (e.g., `order.v1@pod-abc123`).

**Adapter behavior** (when no explicit client ID is configured):
- **Kafka**: uses `serviceName` as `clientId` (visible in broker logs, JMX, ACLs)
- **NATS**: uses `serviceName` as connection `name` (visible in `/connz`)
- **Redis**: uses `serviceName` as `connectionName` (visible in `CLIENT LIST`)

Explicit adapter options (`clientId`, `connectionOptions.name`,
`redisOptions.connectionName`) always take priority over the derived name.
