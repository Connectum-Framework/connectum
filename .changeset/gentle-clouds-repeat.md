---
"@connectum/events": patch
"@connectum/events-amqp": patch
---

docs: recovery backoff tuning and publisher shutdown guidance

- **events-amqp**: accurate reconnect-delay semantics in README and `AmqpRecoveryOptions` JSDoc — amqplib's strategy is symmetric jitter around the exponential base (not equal-jitter), and since amqplib 2.2.0 (the new minimum) the base is capped at `maxDelay / (1 + jitter)`, so a delay never exceeds `maxDelay`. Documented the exact full-jitter recipe: `jitter: 1`, `initialDelay: I/2`, `maxDelay: C` gives a delay uniform in `[0, min(I × factor^(n−1), C)]`.
- **events**: new "Publishers and Shutdown" README section — `stop()` drains consumer handlers only; await-before-stop recipe for at-least-once producers; the stopping-gate limitation for publishes from draining handlers (#212); the planned opt-in `drainPublishTimeout` (#196).
