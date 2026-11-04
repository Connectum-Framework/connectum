---
"@connectum/cli": patch
---

fix: a project scaffolded with `connectum init --auth` now serves the gRPC Health and reflection services without credentials, as its `src/auth.ts` already claimed. The file listed `grpc.health.v1.Health/*` and `grpc.reflection.v1.ServerReflection/*` in the JWT interceptor's `skipMethods` but gave the deny-by-default proto authorizer no rule for them, so `grpc.health.v1.Health/Check` and every reflection call answered `unauthenticated` and `connectum proto sync` failed against the project. The generated file now also allows them with an unconditional authorization rule, covers the `v1alpha` reflection service older clients use, and lists only the protocols the project mounts (`--no-healthcheck`, `--no-reflection`). Every other method stays denied without a token. Projects already scaffolded keep their `src/auth.ts`; to open the services there, add the same patterns to `createProtoAuthzInterceptor({ rules: [...] })` with `effect: AuthzEffect.ALLOW`.
