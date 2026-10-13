---
"@connectum/otel": minor
---

feat: RPC spans and metrics use the attribute names of the current OpenTelemetry RPC conventions for Connect.

**BREAKING** for anything that reads these attributes (dashboards, alerts, queries, span processors, `attributeFilter`) and for code that imports the renamed constants. Shipped as minor on purpose: the `@connectum/*` packages are one fixed version group, so a major here would release every package as 2.0.0.

| Before | After |
| --- | --- |
| `rpc.system` = `connect_rpc` | `rpc.system.name` = `connectrpc` |
| `rpc.service` = `acme.v1.Greeter` and `rpc.method` = `SayHello` | `rpc.method` = `acme.v1.Greeter/SayHello` (equal to the span name); `rpc.service` is gone |
| `rpc.connect_rpc.status_code` = `5` (number, failures only) | `rpc.response.status_code` = `NOT_FOUND` (string; `OK` on a successful unary call) |
| `error.type` = `NOT_FOUND` | unchanged, and now equal to `rpc.response.status_code` on failure |

Prometheus label names change with them: `rpc_system` → `rpc_system_name`, `rpc_service` is dropped (the service is the part of `rpc_method` before `/`), `rpc_connect_rpc_status_code` → `rpc_response_status_code`. A streaming call that started successfully carries no `rpc.response.status_code` (the final status is not known when the response head returns); a failure still sets it.

TypeScript: `ATTR_RPC_SYSTEM`, `ATTR_RPC_SERVICE`, `ATTR_RPC_CONNECT_RPC_STATUS_CODE` and `RPC_SYSTEM_CONNECT_RPC` are replaced by `ATTR_RPC_SYSTEM_NAME`, `ATTR_RPC_RESPONSE_STATUS_CODE` and `RPC_SYSTEM_NAME_CONNECTRPC`; `getLogger()` now names a logger after the service part of `rpc.method`. The `rpc.{server,client}.{request,response}.size` histograms and the `rpc.message` span events are unchanged: the conventions have no replacement for them, and they are documented as Connectum-specific.
