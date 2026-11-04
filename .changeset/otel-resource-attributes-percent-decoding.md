---
"@connectum/otel": minor
---

fix: `OTEL_RESOURCE_ATTRIBUTES` is percent-decoded, as the OpenTelemetry Resource SDK specification requires. `k=v%2Cw` gave the value `v%2Cw`; it now gives `v,w` (a `,` or `=` inside a key or value is written `%2C` or `%3D`, and `+` stays a `+`). A value that is not valid percent-encoding, such as `100%`, discards the whole variable and produces one process warning (code `CONNECTUM_OTEL_INVALID_ENV`) when the provider is created. If a value contained a literal `%` that you did not mean as an escape, write it as `%25`.
