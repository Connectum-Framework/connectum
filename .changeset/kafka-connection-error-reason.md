---
"@connectum/events-kafka": patch
---

fix: a failed connection to a broker whose host name resolves to several addresses (`localhost`) now reports why and where (`Connection error: connect ECONNREFUSED localhost:9092`) instead of `Connection error: ` with an empty reason, and publishing to a topic name the broker refuses as invalid (a space, a wildcard, non-ASCII letters, more than 249 characters) now names the topic and the naming rule. The connection error keeps its class, its `cause` chain and its fields; the invalid-topic error is a new `Error` that carries the broker error as its `cause`.
