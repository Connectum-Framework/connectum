---
"@connectum/otel": minor
---

fix: a streaming call that fails after it started now carries `error.type` and, for a Connect error, `rpc.response.status_code` (the Connect code name, for example `UNAVAILABLE`) on its span and on its duration metric point, on the server and on the client, as a unary call does. Before, the span got status `ERROR` but neither the span nor the metric carried the attributes, so failed streams could not be told apart by error type in a dashboard or an alert. A stream that ends normally, or that the consumer stops reading, still carries neither `error.type` nor `rpc.response.status_code`.
