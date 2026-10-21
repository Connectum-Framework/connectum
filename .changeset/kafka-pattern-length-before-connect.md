---
"@connectum/events-kafka": patch
---

fix: `KafkaAdapter.subscribe()` now refuses a topic pattern longer than 256 characters before it creates a consumer, instead of after the consumer had connected to the broker and had to be released again. The error is the same (`Topic pattern exceeds maximum length (256)`); the refusal no longer opens a connection to the broker.
