---
"@connectum/events": minor
---

feat: named `EventAdapterFactory` type + official DI/testing guidance (#204)

- New exported `EventAdapterFactory` (`() => EventAdapter`) — the previously inline factory shape of `createBroadcastSubscribers`' `adapter` option, now a named public type (per-adapter named types are deliberately not added).
- README gains a "Dependency Injection and Testing" section: the primary pattern is injecting an `EventAdapter` instance at the composition root (a configured test double does not fit a zero-argument factory without a wrapper); the factory is the secondary pattern for per-consumer connections (broadcast reactors). Test-double guidance: `MemoryAdapter` for the generic happy path; broker-specific failure semantics via the upcoming `@connectum/events-amqp/testing` fake (#203).
- Types + docs only — zero runtime change.
