---
"@connectum/interceptors": minor
"@connectum/cli": minor
---

fix: the resilience interceptors and `createDefaultInterceptors` refuse option values that used to run with silently different behaviour, and the bulkhead refusal text states its limits.

**BREAKING** (shipped as minor on purpose: the `@connectum/*` packages are one fixed version group, so a major here would release every package as 2.0.0):

- **Numeric options are validated when the factory is called.** `createTimeoutInterceptor` `duration` is an integer from 1 to 2147483647 ms; `createBulkheadInterceptor` `capacity` is an integer >= 1 and `queueSize` an integer >= 0; `createCircuitBreakerInterceptor` `threshold` is an integer >= 1 and `halfOpenAfter` an integer from 0 to 2147483647 ms; `createRetryInterceptor` `initialDelay` and `maxDelay` are integers from 0 to 2147483647 ms. A fractional value, or a delay above 2147483647 ms (the platform timer fires such a timer after 1 ms, so a "very long" timeout used to expire at once), now throws. A value that is not a number throws `TypeError`; a number outside the rule throws `RangeError`; the message names the factory, the option, the rule and the received value. Before, every refusal was a plain `Error`. `maxRetries` keeps accepting the same values (a fraction such as `0.5` is still valid); only the error class for an invalid one changes to `RangeError` / `TypeError`.
- **`createDefaultInterceptors({ fallback: true })` throws `TypeError`** instead of being ignored; the type of `fallback` is now `false | FallbackOptions`. `createFallbackInterceptor` without a `handler` throws `TypeError` instead of `Error`.
- **A value that is not understood no longer disables an interceptor.** For every key of `createDefaultInterceptors` except `validation`, only `true`, `false`, `undefined` or an options object is accepted; `validation` accepts only a boolean. `null`, a number, a string, an array or a function throws `TypeError` naming the key (`timeout must be true, false or an options object, got null`).
- **`connectum init --resilience fallback` is refused** with the existing `invalid --resilience` message and a hint: a fallback needs an application-specific handler, so add `createFallbackInterceptor({ handler })` to `src/server.ts`. The accepted values are `timeout`, `bulkhead`, `circuitBreaker` and `retry`. Before, the flag scaffolded `fallback: true`, which did nothing.

Also changed, not a contract: the bulkhead refusal text is now `Bulkhead capacity exceeded (capacity: N, queueSize: M)` with the configured limits; it used to print the policy's free slots under the label `active`, so a full bulkhead read as idle. The code stays `ResourceExhausted`; branch on the code, not on the text.

**Migration.** Round fractional values and cap long delays at 2147483647 ms (about 24.8 days); for "no time limit" omit `timeout` instead of passing a huge number. Replace `fallback: true` with `fallback: { handler }` or remove it, and replace `null`, `0` and other non-object values of a `createDefaultInterceptors` key with `false` (disabled), `true` (defaults) or an options object. Remove `fallback` from `--resilience` and add the interceptor by hand. If anything matches on the old bulkhead text, match the `ResourceExhausted` code. See the interceptor options migration guide.
