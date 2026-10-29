---
"@connectum/events-amqp": patch
---

fix: header values that are AMQP tables or arrays reach the handler as JSON text instead of the string `"[object Object]"`. For a message from an external publisher with the headers `nested: { a: 1 }` and `list: [1, "a"]`, `event.metadata` now holds `{"a":1}` and `[1,"a"]` (an array used to arrive as `1,a`); scalars, byte arrays and the omission of null values are unchanged. The documentation now also says that `eventId` is `x-event-id`, else the AMQP `messageId`, else a new random UUID on every delivery, so deduplication on `eventId` works only for messages that carry one of the first two.
