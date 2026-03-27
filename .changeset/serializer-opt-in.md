---
"@connectum/interceptors": major
---

**BREAKING**: Serializer interceptor is now disabled by default in `createDefaultInterceptors()`.

Previously enabled automatically (opt-out via `serializer: false`), now requires explicit opt-in via `serializer: true` or `serializer: { ... }`.

**Migration**: Add `serializer: true` to `createDefaultInterceptors()` if JSON serialization is needed:

```typescript
// Before (serializer was auto-enabled)
createDefaultInterceptors()

// After — if you need JSON serialization
createDefaultInterceptors({ serializer: true })
```

Thanks to @jusandi for identifying the issue with implicit JSON serialization causing problems in streaming between microservices.
