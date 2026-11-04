---
"@connectum/healthcheck": minor
---

fix: `Healthcheck()` validates its options when it is called and refuses a duplicate registration. `Healthcheck(null)`, a `manager` that is not a `HealthcheckManager` (`"x"`, `{}`, `null`) and an `httpEnabled` that is not a boolean (`"yes"`, `1`) now throw `TypeError` naming the option; before they failed later with an unrelated message (`manager.initialize is not a function` at `start()`), or were silently read as true. A second `Healthcheck()` in the same server, or an application service that is already `grpc.health.v1.Health`, is rejected when the server builds its routes: `start()` (and the first call made through `localClient()`) fails with an error naming the Health service, instead of starting with one of the two managers silently ignored. Valid configurations are unchanged; one `Healthcheck()` registration object can still be passed to several servers.
