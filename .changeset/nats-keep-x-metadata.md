---
"@connectum/events-nats": minor
---

fix: the NATS adapter delivers the metadata a caller published as it was given. It used to drop every key that starts with `x-` on publish and every empty value on receive, so a handler that read `x-request-id` saw it on Redis and in memory but not on NATS. Only `x-event-id` stays the adapter's own: it carries the event id the adapter generates and a value passed in `metadata` is ignored, as before. A handler that relied on such a key being absent now sees it.
