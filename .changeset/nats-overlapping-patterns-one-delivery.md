---
"@connectum/events-nats": patch
---

fix: an event matched by several patterns of one subscription is handled once

A JetStream consumer delivers a stream message once, and the adapter keeps one durable consumer per pattern, so a route set such as `user.created`, `user.*`, `user.>` ran the handler three times for a single `user.created`. The adapter now runs the handler for one of those deliveries, the one of the most specific pattern whose consumer delivers the event (fewer `>`, then fewer `*`, then more tokens, then the pattern text; the same on every replica), and acknowledges the others without running it. Partly overlapping patterns (`a.*.c`, `a.b.*`) need no special case.

The consumer layout on the broker does not change: same durable names, same filters, one consumer per pattern. Upgrading or rolling back needs no action, and the backlog of consumers that already exist (events published while the service was down) is delivered once. The network still carries one copy per matching pattern.

To let every replica skip the same deliveries, the adapter writes `connectum.start_seq` (the first stream sequence the consumer delivers) into the metadata of each consumer once: when it creates the consumer, or the first time it attaches to one made by an earlier version. nats-server 2.9 has no consumer metadata: there the adapter logs one warning per process and works without the record.

While a service is rolled out with a route added to a broader pattern, an event can be handled by both the old and the new replicas, so a handler may see it twice but never zero times; that is the at-least-once contract. `subscribe()` that fails half-way now removes only the consumers it created itself; before, it also deleted a consumer of the same group that existed already.
