---
"@connectum/interceptors": minor
---

feat: opt-in `includeTransport` on `createLoggerInterceptor`

With `includeTransport: true` every log line of a call is tagged with the
transport that carried it, right after the `RPC` / `STREAM` prefix:
`[in-process]` for calls made through `server.localClient()` /
`createLocalTransport()` of `@connectum/core`, `[http]` for every other call.
A forged in-process marker on an inbound HTTP request is stripped by the
server, so such a call is still logged as `[http]`.

The tag is telemetry only — do not base authorization or other security
decisions on it; use `req.service.typeName` and `req.method.name`.

Off by default: without the option the log lines are unchanged.
