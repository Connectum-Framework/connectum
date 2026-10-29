---
"@connectum/otel": minor
---

fix: failure attributes of the server and client interceptors follow the semantic conventions for two cases. `error.type` is never empty any more: an error whose class has no name (an anonymous `class extends Error`) reports the error's `name` (usually `Error`), and `_OTHER` when that is empty too. The `exception` span event of a `ConnectError` now carries the class name in `exception.type` (`ConnectError`); it used to carry the numeric Connect code (`"5"` for `NOT_FOUND`) because the OpenTelemetry SDK reads a numeric `code` property before the `name`. The Connect code stays in `error.type` and `rpc.response.status_code`. Queries or alerts that match `exception.type` against Connect code numbers must switch to `error.type`, the Connect code name, or `ConnectError`; see the RPC telemetry migration page.
