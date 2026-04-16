---
"@connectum/events": minor
---

feat(events): auto-resolve publish topic from proto annotations

EventBus.publish() now automatically resolves the topic from proto
`(connectum.events.v1.event).topic` option when no explicit topic is
provided in PublishOptions. This eliminates the need to manually
duplicate topic strings between proto definitions and publish calls.

Priority order:
1. Explicit `publishOptions.topic` (override)
2. Proto annotation topic (auto-resolved from registered routes)
3. `schema.typeName` (fallback, backward compatible)
