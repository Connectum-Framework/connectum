---
"@connectum/otel": minor
---

Support `service.instance.id` and custom resource attributes in `initProvider`.

`ProviderOptions` gains two optional, backwards-compatible fields:

- `instanceId` — sets `service.instance.id` on the resource (OTel semconv), so a
  fleet of same-role processes can be told apart in telemetry.
- `resourceAttributes` — extra resource attributes (e.g. `device.id`,
  `facility`) merged into the resource.

The standard `OTEL_SERVICE_INSTANCE_ID` and `OTEL_RESOURCE_ATTRIBUTES` env vars
are now honored, with explicit options taking precedence. The resource is built
once and shared across traces, metrics, and logs so instance id and custom
attributes apply consistently to every signal (previously the resource was
built three times from service name/version only). Existing callers are
unaffected — all new fields are optional.
