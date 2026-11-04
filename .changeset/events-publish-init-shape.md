---
"@connectum/events": patch
---

fix: `bus.publish()` and `ctx.publish()` accept a plain object for `data`. The parameter type is now `MessageInitShape<Desc>` instead of `MessageShape<Desc>`, so `bus.publish(OrderSchema, { id: "1" })` compiles without `$typeName` or a wrapping `create(...)`, and nested messages, repeated fields and oneofs can be written inline. A fully built message still compiles and publishes the same bytes. Only the declared type changes; the runtime already built the message with `create(schema, data)`.
