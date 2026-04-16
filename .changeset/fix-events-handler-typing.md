---
"@connectum/events": patch
---

fix(events): preserve concrete input types in ServiceEventHandlers

Changed `ServiceEventHandlers` mapped type to derive handler input types from
`S["method"]` (concrete GenService record) instead of `S["methods"][number]`
(generic DescMethod array). This preserves concrete protobuf message types
in event handlers, eliminating the need for `as unknown as T` casts.

Closes #86
