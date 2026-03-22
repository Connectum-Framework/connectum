---
"@connectum/otel": patch
---

Make initProvider() idempotent instead of throwing on repeated calls

Previously, calling initProvider() after getMeter()/getTracer()/getLogger()
(which auto-initialize the provider) would throw "already initialized".
Now initProvider() is a no-op if provider already exists, matching the
documented behavior that explicit initialization is optional.
