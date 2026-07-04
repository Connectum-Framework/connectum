---
"@connectum/events": patch
"@connectum/events-amqp": patch
---

docs: recovery backoff tuning and publisher shutdown guidance

- **events-amqp**: accurate reconnect-delay semantics in README and `AmqpRecoveryOptions` JSDoc — the amqplib v2 strategy is symmetric jitter around the exponential base (not equal-jitter), with the cap applied before jitter (hence the overshoot above `maxDelay`). Documented the exact full-jitter workaround (`jitter: 1` + halved `initialDelay`/`maxDelay` → delay uniform in `[0, intended cap]`, verified against amqplib 2.0.1) with a fragility caveat and upstream tracking links (amqp-node/amqplib#855, amqp-node/amqplib#856).
- **events**: new "Publishers and Shutdown" README section — `stop()` drains consumer handlers only; await-before-stop recipe for at-least-once producers; the stopping-gate limitation for publishes from draining handlers (#212); the planned opt-in `drainPublishTimeout` (#196).
