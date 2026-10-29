---
"@connectum/otel": minor
---

fix: a server span gets status `ERROR` only for the Connect codes that the OpenTelemetry Connect RPC conventions treat as server errors: `unknown`, `deadline_exceeded`, `unimplemented`, `internal`, `unavailable` and `data_loss`, and for an error that is not a `ConnectError` (the server turns it into `unknown`). A call that ends with any other code (`not_found`, `invalid_argument`, `permission_denied`, `unauthenticated`, `failed_precondition`, `canceled`, ...) is the caller's outcome, not a failure of the server, and now leaves the server span status unset. Before, every non-OK code marked the span `ERROR`, so a burst of `NOT_FOUND` answers looked like server errors in trace backends. The client span is unchanged: every code except `OK` is an error for a client. `error.type` and `rpc.response.status_code` are unchanged on both spans and on the metrics.

Trace queries and alerts that count server spans with `status = error` as "failed requests" now count only server-class failures; use `rpc.response.status_code` or `error.type` to count every non-OK code. The same applies to the failure of a streaming call that started successfully.
