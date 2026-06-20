---
"@connectum/events": minor
---

Add `EventBusOptions.publishes` for publisher-only processes. A process that publishes an event without subscribing to it had no `routes`, so `publish()` fell back to the message `typeName` and silently emitted to the wrong topic whenever the event declared a custom `(connectum.events.v1.event).topic`. List the event service descriptors in `publishes` to resolve the declared topic from the proto option end-to-end, instead of hand-maintaining raw topic strings.
