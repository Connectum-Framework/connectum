---
"@connectum/testing": minor
---

feat: `transportParityTest` takes an opt-in `telemetry: { shutdownProvider }` option, and `withTelemetry({ shutdownProvider }, body)` does the same around any test body. Both reset the `@connectum/otel` provider, register fresh span and metric collectors as the OpenTelemetry providers, and unregister them afterwards, also when the scenario throws. Before, a parity test that only registered its collector saw spans in the first test of a process and none in later ones, because `@connectum/otel` keeps the tracer of the first registered provider; two empty results then compared as equal and the test passed. Without the option the driver behaves as before. `shutdownProvider` is passed in, so `@connectum/testing` still does not depend on `@connectum/otel`.
