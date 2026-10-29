---
"@connectum/healthcheck": patch
---

fix: `GET /healthz?service=` (an empty `service` value) now reports `"service": "overall"` in the JSON body, as a request without the parameter does and as the guide documents. The status and the HTTP code were already those of the overall state; only the body field was an empty string.
