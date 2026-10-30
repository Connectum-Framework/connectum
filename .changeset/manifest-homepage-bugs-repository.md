---
"@connectum/auth": patch
"@connectum/cli": patch
"@connectum/core": patch
"@connectum/events": patch
"@connectum/events-amqp": patch
"@connectum/events-kafka": patch
"@connectum/events-nats": patch
"@connectum/events-redis": patch
"@connectum/healthcheck": patch
"@connectum/interceptors": patch
"@connectum/otel": patch
"@connectum/protoc-gen-catalog": patch
"@connectum/reflection": patch
"@connectum/test-fixtures": patch
"@connectum/testing": patch
---

fix: every package manifest now carries `homepage` (the package page on https://connectum.dev), `bugs.url` (the repository issue tracker) and one `repository` form (`git+https://github.com/Connectum-Framework/connectum.git` plus the package `directory`). Before, none of the 15 packages declared `homepage` or `bugs`, so the npm package page had no documentation or issue links and `npm docs` / `npm bugs` had nothing to open; the four events adapters also wrote `repository.url` without the `git+` prefix. The release gate now fails if any installed package differs from this form.
