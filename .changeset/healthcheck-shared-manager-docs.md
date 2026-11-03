---
"@connectum/healthcheck": patch
---

docs: the README and the `manager` option now state what happens when two servers in one process use `Healthcheck()` without `manager`. They share the `healthcheckManager` singleton, and each server's start keeps only that server's services in it. After the second server starts, the first one keeps running but answers `NOT_FOUND` for its own services and `NOT_SERVING` overall. Pass `manager: createHealthcheckManager()` to every server of such a process. A new integration suite asks a `grpc.health.v1.Health` client of two running servers and confirms both the shared and the isolated case.
