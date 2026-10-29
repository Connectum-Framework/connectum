---
"@connectum/core": minor
---

fix: the environment schema is stricter about two variables. `PORT` must be written in decimal digits: `0x50`, `1e3`, `+80` and values with surrounding spaces, which `Number()` read as ports, are rejected with an issue on `PORT`. `OTEL_EXPORTER_OTLP_ENDPOINT` must be an `http:` or `https:` URL: `localhost:4318` and `ftp://x` are rejected with an issue on that variable instead of failing later in the exporter. Documented values are unaffected.
