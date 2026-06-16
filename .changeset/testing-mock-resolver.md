---
"@connectum/testing": minor
---

feat(testing): mock resolver + mock handler context for the service catalog

- **`mockResolver(mocks)` / `mockService(service, impl)`** — a `RemoteResolver`
  that serves canned implementations in-process; every response is tagged with
  `x-connectum-mock: true` (`MOCK_RESPONSE_HEADER`) so tests can prove a call was
  mock-served. Returns `null` for unmocked services, so it composes with real
  resolvers.
- **`createMockContext({ catalog, mocks, ... })`** — build a Connectum `Context`
  for unit-testing a handler's `ctx.call` / `ctx.stream` in isolation. It drives
  the SAME catalog dispatch path as a live request (resolver lookup, cascade,
  interceptors, error semantics), so there is no parallel mock path to drift
  from.
