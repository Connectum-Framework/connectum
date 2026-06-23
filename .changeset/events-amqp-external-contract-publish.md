---
"@connectum/events-amqp": minor
---

Add `publisherOptions.externalContract` for publishing against an external (non-EventBus) AMQP/AsyncAPI contract. When set, the adapter suppresses the EventBus envelope so the wire frame carries only contract-specified properties — no `x-event-id` / `x-published-at` headers, no auto-populated `messageId` / `timestamp`, and (for `mandatory` publishes) single-flight correlation so no `x-connectum-publish-id` header reaches the wire (`correlationHeader` is ignored in this mode). The frame then carries only `contentType`, `persistent`/deliveryMode, `mandatory`, and the headers supplied via `PublishOptions.metadata`.

This closes the gap where `correlationHeader: false` was documented as yielding a "clean wire" but the envelope still shipped (#161). Default (EventBus) behavior is unchanged: the envelope is stamped on publish and stripped on delivery. Verified with a raw amqplib consumer against a real broker. A caller-controlled `messageId` / `timestamp` (needs a cross-package `PublishOptions` field) remains a documented follow-up.
