---
"@connectum/cli": patch
---

fix: `connectum init --no-healthcheck` no longer leaves anything that calls the health endpoint. `Dockerfile` and `Dockerfile.bun` lose the `HEALTHCHECK` that probed `/healthz` (and the `curl` install made for it), and `package.json` no longer depends on `@connectum/healthcheck`. Before, a project scaffolded without the health protocol shipped a container that Docker would mark unhealthy once the start period ended, because `/healthz` answers 404 when the protocol is not mounted.
