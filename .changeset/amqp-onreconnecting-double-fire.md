---
"@connectum/events-amqp": patch
---

Fix `onReconnecting` firing twice per failed reconnect cycle. amqplib emits both `connect-failed` and `reconnect-scheduled` for a single failed attempt; the adapter now derives `onReconnecting` solely from `reconnect-scheduled`, so it fires exactly once per scheduled retry. The terminal, retries-exhausted case remains `onReconnectFailed`. Removes the undocumented `{ attempt: -1 }` sentinel that double-counted reconnect metrics.
