---
"@connectum/events-amqp": patch
---

fix: a failed connect to a hostname that resolves to several addresses (`localhost` resolves to both `::1` and `127.0.0.1`) now reports why. Node raises it as an `AggregateError` with an empty message, so `AmqpConnectionError: Initial connect failed after N attempt(s)` carried a `cause` that named nothing, and `recovery: false` threw a bare `AggregateError ""`. The adapter now fills the empty message with the members' texts (for example `connect ECONNREFUSED ::1:1; connect ECONNREFUSED 127.0.0.1:1`) on the error itself, so its class, `code` and `errors` are unchanged. The same error passed to the `reconnecting`, `reconnect-failed` and `disconnected` lifecycle events is readable too.
