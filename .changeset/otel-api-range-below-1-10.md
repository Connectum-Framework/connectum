---
"@connectum/otel": patch
"@connectum/testing": patch
---

fix: `@opentelemetry/api` is declared as `>=1.9.0 <1.10.0` instead of `^1.9.0`. Every OpenTelemetry SDK 2.x package these packages depend on declares the peer range `<1.10.0`, so an install without a lockfile (the one an application has) resolved the api package to 1.10.0 and reported an unmet peer; the repository's own lockfile pinned 1.9.1 and hid it. The api package stays on 1.9.x until the SDK packages accept 1.10.
