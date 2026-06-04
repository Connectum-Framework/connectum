---
"@connectum/core": minor
---

feat(core): expose `jsonOptions` in `createServer()` to control Connect JSON serialization

`CreateServerOptions` now accepts an optional `jsonOptions` field
(`Partial<JsonReadOptions & JsonWriteOptions>`) that is threaded through to the
underlying `connectNodeAdapter`. It applies server-wide, so it also covers
protocol services registered by the framework (healthcheck, reflection).

The most common use is emitting fields with implicit presence (proto3 scalar
`0`, empty string/list, enum default) in JSON responses instead of omitting
them:

```typescript
const server = createServer({
  services: [routes],
  jsonOptions: { alwaysEmitImplicit: true },
});
```

For per-service control, the same option can still be passed as the third
argument of `router.service()` inside a service route.
