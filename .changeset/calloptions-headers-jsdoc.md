---
"@connectum/core": patch
---

docs: the `CallOptions.headers` JSDoc no longer claims that no inbound header is propagated. By default none is, but the inbound headers listed in `createServer({ propagateHeaders })` are copied onto an outgoing `ctx.call` / `ctx.stream`, and the explicit `headers` are sent on top of them and win on a name conflict. Trace context is injected by the `@connectum/otel` client interceptor when it is mounted in `outgoingInterceptors`. No behaviour change.
