---
"@connectum/otel": minor
---

fix: an exception in the `filter` or `attributeFilter` option of `createOtelInterceptor()` and `createOtelClientInterceptor()` no longer fails the call. Before, a throwing callback made every RPC fail (`internal` on the server, `unknown` on the client). Now the call goes through and the error is reported once per interceptor to the OpenTelemetry diagnostics channel (`diag.error`; it prints once a diagnostics logger is registered, which `initProvider()` does at `ERROR` level). A throwing `filter` instruments the call. A throwing `attributeFilter` drops the attribute it was asked about, so an attribute is still exported only if the filter approved it; the other attributes are kept.
