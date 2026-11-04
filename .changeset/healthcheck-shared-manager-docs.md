---
"@connectum/healthcheck": patch
---

docs: the README and the `manager` option now state what happens when two servers in one process use `Healthcheck()` without `manager`. They share the `healthcheckManager` singleton, and each server's start keeps only that server's services in it. The second start removes the services it does not mount, so the first server keeps running but answers `NOT_FOUND` for its own services that are missing there; overall health is computed over the shared registry and also depends on the other server's statuses. Pass `manager: createHealthcheckManager()` to every server of such a process. A new integration suite asks a `grpc.health.v1.Health` client of two running servers and confirms both the shared and the isolated case.
