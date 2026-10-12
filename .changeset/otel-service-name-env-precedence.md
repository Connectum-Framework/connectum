---
"@connectum/otel": patch
---

fix: `OTEL_SERVICE_NAME` now takes priority over `service.name` in `OTEL_RESOURCE_ATTRIBUTES`, as the OpenTelemetry SDK environment-variable specification requires. Before, when both were set, the entry in `OTEL_RESOURCE_ATTRIBUTES` silently replaced the name from `OTEL_SERVICE_NAME` (and from the `serviceName` option) on the exported resource. The resolution order is now: the `serviceName` option, `OTEL_SERVICE_NAME`, `service.name` in `OTEL_RESOURCE_ATTRIBUTES`, `npm_package_name`, `"unknown-service"`. A deployment that set both variables to different names now reports the name from `OTEL_SERVICE_NAME`.
