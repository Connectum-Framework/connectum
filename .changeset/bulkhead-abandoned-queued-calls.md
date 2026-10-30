---
"@connectum/interceptors": patch
---

fix: a call that waits in the `createBulkheadInterceptor` queue and is abandoned by its client now leaves the queue at once. Before, it kept its queue place until a slot freed, so a later caller could be refused with `ResourceExhausted` although the queue held only a dead entry, and its handler then ran with an already aborted `ctx.signal`. The abandoned call now fails with `Canceled` (the abort reason itself when it is a `ConnectError`) and its handler never runs; a call that arrives with an already aborted signal fails the same way without taking a slot or a queue place. Capacity, queue size, queue order and the `ResourceExhausted` text are unchanged.
