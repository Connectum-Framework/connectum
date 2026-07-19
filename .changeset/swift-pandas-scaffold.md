---
"@connectum/cli": minor
---

feat: `connectum init` and `connectum generate service` — project scaffolding

- **`connectum init`** scaffolds a production-ready standalone project, interactively (a `@clack/prompts` wizard) or fully from flags (`--yes` / CI / non-TTY). The base is fetched from the dogfooded `getting-started` example via a degit-style clone, so the starter layout stays in sync with a tested example instead of a drift-prone template copy; the selected modules are composed on top.
- **Modules:** OpenTelemetry (`--otel`), EventBus with an adapter (`--events nats|kafka|redpanda|redis|amqp`), auth (`--auth`, JWT + proto-driven authorization), service catalog (`--catalog`, typed `ctx.call`/`ctx.stream`), opt-in resilience interceptors (`--resilience timeout,retry,...`), and health/reflection toggles. Runtime (`node`/`bun`), package manager (`pnpm`/`npm`) and the Node execution model (`raw` `.ts` >= 25.2 vs `tsx` >= 22.13) are all first-class choices.
- **Deterministic interceptor order.** When several interceptor-adding modules are selected the composition root emits one canonical chain (outermost → innermost): OpenTelemetry → error handler → auth → validation → resilience → custom, with exactly one error handler.
- **Lifecycle fix baked in.** `buf generate` is chained into the generated `start` / `test` / `typecheck` scripts (not a pnpm `pre*` hook, which silently no-ops), so a fresh clone never fails with an unresolved `#gen/...` import. Standalone pnpm projects also get the `buf` build-approval that pnpm 11 requires.
- **`connectum generate service <name>`** adds a service to an existing project: a starter proto plus a `defineService` skeleton whose rpc handlers throw `Code.Unimplemented` (a deliberate, documented trade-off — the handler-map key must still exist, so a later proto method addition remains a compile error). `--with-events` also scaffolds an event-handler service and an ack-by-default `EventRoute`. It never edits your `src/server.ts`; it prints the exact registration to add.
- **Generated tests are runtime-agnostic**: the e2e test uses the public in-process `createLocalClient` from `@connectum/testing` (no socket, identical on Node and Bun); event-enabled projects also get a broker-free `MemoryAdapter` smoke test.
- A CI scaffold matrix (`cli-scaffold-matrix`) scaffolds each named module combination and runs `buf generate` → typecheck → test, so a broken fragment fails CI.
