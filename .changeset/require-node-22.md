---
"@connectum/core": major
"@connectum/interceptors": major
"@connectum/auth": major
"@connectum/healthcheck": major
"@connectum/reflection": major
"@connectum/otel": major
"@connectum/cli": major
"@connectum/testing": major
"@connectum/events": major
"@connectum/events-nats": major
"@connectum/events-kafka": major
"@connectum/events-redis": major
"@connectum/events-amqp": major
---

chore: raise minimum supported Node.js to 22.13.0

The `engines.node` requirement for all packages is raised from `>=20.0.0` to
`>=22.13.0`. Node.js 20 reached end-of-life on 2026-04-30 and no longer receives
security updates.

Node.js 22 is the current LTS line. Consumers on Node.js 20 or earlier must
upgrade to Node.js 22.13.0 or later. Packages continue to ship compiled
JavaScript, so no build-step changes are required on the consumer side.

Marked as a major change because raising the runtime floor is breaking for
consumers on Node.js 20; it lands in the upcoming 1.0.0 baseline.
