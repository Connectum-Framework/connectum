---
"@connectum/otel": patch
---

`@connectum/otel`: `shutdownProvider()` no longer leaves the provider in a broken state, and a provider created after a shutdown now works.

- When stopping failed (for example an unreachable OTLP collector), `getProvider()` kept handing out the half-stopped provider and a repeated `shutdownProvider()` returned the same error. The provider is now released whether stopping succeeds or fails; the call still rejects with the failure.
- Tracing, metrics and logging used to be stopped one after another, so a failing first signal left the other two running with unflushed buffers. They are now stopped independently; one failure is rethrown as it is, several as an `AggregateError`.
- The OpenTelemetry API global registrations (trace, context, propagation, metrics, logs) survived a shutdown, so a provider created afterwards was refused as a duplicate and its `meter` became a no-op: RPC metrics disappeared without a message. Shutdown now releases exactly the registrations the provider took and leaves those held by other code alone, and the provider's `meter` comes from its own meter provider.
- `createOtelInterceptor` and `createOtelClientInterceptor` created before a shutdown kept recording into the stopped meter provider; they now follow the current one.

The package now lists `@opentelemetry/context-async-hooks` and `@opentelemetry/core` as dependencies (they were development-only) because the provider registers the context manager and the propagator itself.
