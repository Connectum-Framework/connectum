# Interceptor integration tests

These tests exercise combinations of `@connectum/interceptors` against real
in-process Connect handlers. The suites cover the default chain, resilience
behavior, logging, and validation; they do not measure production traffic or
external service behavior.

Run the integration suites from the framework repository root:

```bash
pnpm --filter @connectum/interceptors test:integration
```

The package README and [interceptors guide](https://connectum.dev/en/guide/interceptors)
describe configuration and behavior for applications. Test cases in this
directory are the source of truth for the scenarios exercised here.
