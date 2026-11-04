---
"@connectum/core": minor
---

fix: the environment schema is stricter about two variables. `PORT` must be written in decimal digits: `0x50`, `1e3`, `+80` and values with surrounding spaces, which `Number()` read as ports, are rejected with an issue on `PORT`. `OTEL_EXPORTER_OTLP_ENDPOINT` must be an `http:` or `https:` URL: `localhost:4318` and `ftp://x` are rejected with an issue on that variable instead of failing later in the exporter. Documented values are unaffected.

An empty `OTEL_SERVICE_NAME` or `OTEL_EXPORTER_OTLP_ENDPOINT` is now read as unset, as the OpenTelemetry SDK reads an empty value of its variables (the empty endpoint used to be rejected as an invalid URL). A `PORT` written with leading zeros such as `08080` is still accepted and read as decimal 8080.
