---
"@connectum/interceptors": minor
"@connectum/test-fixtures": minor
---

fix!: timeout now cancels downstream work and retry stops on cancellation, so a timed-out or cancelled call no longer retries or returns a late success

**Behaviour change.** Before, the timeout interceptor only stopped the caller from waiting: the downstream chain and the handler received no signal and kept running, and retry could start another attempt or return a late success after the caller had already been told the call failed. Now:

- When the timeout expires, `req.signal` (and `ctx.signal` in the handler) is aborted with a `DeadlineExceeded` `ConnectError` ("Request timeout after Nms"). Caller cancellation is forwarded the same way. The first cancellation cause decides the error: an existing caller `ConnectError` keeps its code, message, metadata and details; any other caller reason becomes `Canceled`.
- Retry interrupts a pending backoff, never starts another attempt after cancellation, and turns a late success of cancelled work into a cancellation error. Retry still waits for a running signal-unaware handler to settle, so a surrounding bulkhead keeps counting that work as active.
- Code that relied on a late successful response, or on one more retry after a timeout or cancellation, now receives `DeadlineExceeded` or `Canceled`. Handlers and I/O must observe the signal to stop work; cancellation does not roll back side effects of code that ignores it.

**Timeout and circuit breaker.** With the default order (`timeout` outside `circuitBreaker`, which wraps `retry`), an expired timeout now reaches the breaker as a `DeadlineExceeded` failure, and `DeadlineExceeded` is one of the codes the default failure predicate counts. Repeated timeouts of a cooperative handler therefore open the circuit; before, the breaker never saw the timeout and only saw whatever the abandoned handler eventually returned. For a handler that ignores the signal, the failure is recorded when that handler settles (not when the caller gets its deadline error), and only because `retry` turns the late result into the cancellation error. A caller cancellation with the default `Canceled` code is not a circuit failure; a caller `ConnectError` reason that carries an infrastructure code (for example `Unavailable`) is counted under its own code. If timeouts must not trip the breaker, pass a `failurePredicate` that excludes `DeadlineExceeded`.

Public options, defaults and chain order are unchanged. Streaming stays skipped by default; with `skipStreaming: false` the timeout and retry cover opening the response only, and caller cancellation still reaches an opened stream. See "Cancellation behavior in 1.3" in the interceptors README for migration notes.

`@connectum/test-fixtures`: mock requests now carry an independent, non-aborted `signal`, as the ConnectRPC request contract requires.
