---
"@connectum/healthcheck": minor
---

Health components for RPC-less workers: `register()` / `set()` / `unregister()` on `HealthcheckManager`.

A worker with `services: []` could never become SERVING — the registry stayed empty, `/healthz` answered 503 permanently, breaking docker-compose `service_healthy` gating. Now the application can register arbitrary health components that participate in `areAllHealthy()`, gRPC `Check`/`Watch`, and `/healthz` exactly like RPC services:

```typescript
healthcheckManager.register('process');
server.on('ready', () => healthcheckManager.set('process', ServingStatus.SERVING));
server.on('stopping', () => healthcheckManager.set('process', ServingStatus.NOT_SERVING));
```

Component names are validated (non-empty, dot-free — proto typeNames are always dotted, so the namespaces cannot collide).

Behavioral note: registry entries are now kind-tagged. `initialize()` (called by the Healthcheck protocol on server start) replaces only the **service slice**: components always survive, services absent from the new registration are removed (watchers observe `SERVICE_UNKNOWN`). Components may be registered before or after `server.start()`.
