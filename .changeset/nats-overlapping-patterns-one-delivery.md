---
"@connectum/events-nats": patch
---

fix: an event matched by several patterns of one subscription is handled once

A JetStream consumer delivers a stream message once, and the adapter keeps one durable consumer per pattern, so a route set such as `user.created`, `user.*`, `user.>` ran the handler three times for a single `user.created`. The adapter now runs the handler for one of those deliveries, the one of the most specific pattern whose consumer delivers the event (fewer `>`, then fewer `*`, then more tokens, then the pattern text; the same on every replica), and acknowledges the others without running it. Partly overlapping patterns (`a.*.c`, `a.b.*`) need no special case.

The consumer layout on the broker does not change: same durable names, same filters, one consumer per pattern. Upgrading or rolling back needs no action, and the backlog of consumers that already exist (events published while the service was down) is delivered once. The network still carries one copy per matching pattern.

The adapter reads the consumers it finds and never changes their configuration, so an earlier version of the adapter can start again after a rollback (a consumer created again with the same configuration is accepted by every supported server), and consumers provisioned by an operator need only read and pull permissions. Replicas compute where each consumer starts from what the server reports; a delivery below that bound still runs the handler, so replicas that disagree can run a handler twice for an event, never zero times. When an existing consumer was made with another `ackWait`, `maxDeliver` or `deliverPolicy` than the subscription asks for, the adapter keeps it and logs one warning per consumer.

While a service is rolled out with a route added to a broader pattern, an event can be handled by both the old and the new replicas, so a handler may see it twice but never zero times; that is the at-least-once contract. `subscribe()` that fails half-way now removes only the consumers of an auto-generated group; the consumers of a named group stay for the next start (before, a failing call also deleted a consumer of the group that existed already, which stops the replica reading it without an error).
