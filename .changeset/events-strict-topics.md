---
"@connectum/events": minor
---

Add an opt-in `EventBusOptions.strictTopics`. By default, when `publish()` finds no explicit `publishOptions.topic` and the event type is covered by neither `routes` nor `publishes`, it silently falls back to the raw message `typeName` — a silent misconfiguration that can emit to a topic no subscriber expects. With `strictTopics: true`, that unresolved-topic case throws at the call site instead. Default stays `false` (backward-compatible).
