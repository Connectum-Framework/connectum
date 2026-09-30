---
"@connectum/otel": minor
"@connectum/testing": patch
"@connectum/healthcheck": patch
---

feat(otel): export the `OtelProvider` type returned by `getProvider()`

- `@connectum/otel`: `getProvider()` returned a type the package did not
  export, so callers could not name it to store or pass the provider on. It is
  now exported (from the root entry and from `@connectum/otel/provider`) as an
  interface — `tracer`, `meter`, `logger` and `shutdown()` — with no public
  constructor: the package still keeps exactly one provider per process.
  `provider.shutdown()` does not reset that instance; `shutdownProvider()` does.
- `@connectum/testing`: the `InMemorySpanCollector` docs named a
  `registerGlobal` method that does not exist. They now describe the real way to
  make the collector global: `trace.setGlobalTracerProvider(collector.provider)`,
  then `trace.disable()` before `dispose()`.
- `@connectum/healthcheck`: the `ServingStatus` docs list the enum values of the
  gRPC Health Checking Protocol it re-exports.
