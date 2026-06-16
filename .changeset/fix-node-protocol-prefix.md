---
"@connectum/core": patch
"@connectum/auth": patch
"@connectum/interceptors": patch
"@connectum/healthcheck": patch
"@connectum/reflection": patch
"@connectum/cli": patch
"@connectum/otel": patch
"@connectum/test-fixtures": patch
"@connectum/protoc-gen-catalog": patch
"@connectum/events": patch
"@connectum/events-nats": patch
"@connectum/events-kafka": patch
"@connectum/events-redis": patch
"@connectum/events-amqp": patch
---

fix: preserve the `node:` protocol prefix on builtin imports

tsup strips the `node:` prefix from builtin imports by default (`removeNodeProtocol: true`). The bare forms (`crypto`, `fs`, `http2`, …) are valid Node aliases, but the `node:` prefix is the portable specifier across runtimes — Deno resolves builtins prefix-first (bare forms are not guaranteed), and prefix-only builtins like `node:test` have no bare alias at all. Every package now sets `removeNodeProtocol: false`, so the published artifacts keep the prefix on every builtin import for maximum cross-runtime portability (Node / Bun / Deno). No runtime behavior change on Node. (`@connectum/testing` already carried this fix.)
