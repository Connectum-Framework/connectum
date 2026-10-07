# Interceptor integration tests

These tests combine `@connectum/interceptors` using mock requests and downstream
handlers, plus real in-process and HTTP/2 calls for logger behavior. The suites
cover chain composition, resilience, logging, and validation; they do not measure
production traffic or external service behavior.

Run the integration suites from the framework repository root:

```bash
pnpm build
pnpm --filter @connectum/interceptors test:integration
```

The package README and [interceptors guide](https://connectum.dev/en/guide/interceptors)
describe configuration and behavior for applications. Test cases in this
directory are the source of truth for the scenarios exercised here.
