---
"@connectum/core": major
---

**BREAKING** (behavioral): startup validation of bidi-streaming methods vs the effective transport.

Per the Connect protocol, bidirectional streaming requires HTTP/2 — but the default `createServer()` transport without TLS is plaintext HTTP/1.1 (`allowHTTP1: true`). Previously a bidi service registered cleanly on that transport and failed silently at runtime: the first client send hung forever (or yielded HTTP 505). Now `server.start()` rejects with a `TransportValidationError` carrying the stable code `CONNECTUM_UNSUPPORTED_STREAMING_TRANSPORT`, the affected `service.method` list with streaming kinds, and both fixes (`allowHTTP1: false` for h2c, or TLS with ALPN). The rejected promise and the `error` event carry the same error object.

New option:

```typescript
createServer({
  // "error" (default) — fail fast at start()
  // "warn"  — log the diagnostic once and start anyway
  // "off"   — skip the check
  transportValidation: "error" | "warn" | "off",
});
```

Unary, server-streaming, and client-streaming methods are unaffected on any transport (the Connect protocol supports them over HTTP/1.1). A TLS server that also allows HTTP/1.1 (`allowHTTP1: true`) emits a one-time **warning** for bidi methods — never a hard error — because a client negotiating HTTP/1.1 over TLS hits the same hang; set `allowHTTP1: false` to refuse HTTP/1.1 at ALPN and remove the risk. A TLS or h2c server restricted to HTTP/2 never triggers the check.

Deployments that knowingly ran bidi services on an HTTP/1.1-permitting config (they were broken at runtime) can downgrade with `transportValidation: "warn"` or `"off"`. Exported: `TransportValidationError`, `TRANSPORT_VALIDATION_ERROR_CODE`, `collectStreamingMethods`.
