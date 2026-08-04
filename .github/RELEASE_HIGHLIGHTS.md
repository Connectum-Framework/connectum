<!--
  Curated release highlights for the NEXT release. Maintainer-edited.
  `scripts/build-release-notes.mjs` prepends this verbatim as the "## Highlights"
  section of both the GitHub Release notes and the Version Packages PR body.
  Keep it SHORT: the few most important user-facing changes, ONE concise line
  each. The per-package sections below already carry the full detail — do NOT
  duplicate it here. Update (or clear) this file when cutting a new release.
-->
- **Project scaffolding** — the new `connectum init` scaffolds a production-ready project, interactively or fully from flags, composing only the modules you pick (OpenTelemetry, EventBus with an adapter, auth, service catalog, resilience), and `connectum generate service` adds a service with a starter proto and a `defineService` skeleton ([#229](https://github.com/Connectum-Framework/connectum/pull/229)).
- **Reliable AMQP publishing** — opt-in `publishRetry` on `@connectum/events-amqp` auto-retries connection-class publish failures (never nacks/timeouts) with bounded backoff and honest at-least-once semantics ([#222](https://github.com/Connectum-Framework/connectum/pull/222)), and the new `drainPublishTimeout` on `@connectum/events` gives in-flight publishes a bounded drain window during `stop()` ([#220](https://github.com/Connectum-Framework/connectum/pull/220)).
- **Deterministic AMQP failure policy** — `initialConnectMaxRetries` bounds the first connect ([#219](https://github.com/Connectum-Framework/connectum/pull/219)), and `treatTopologyErrorAsFatal` stops infinite recovery on deterministic topology drift (404/406) at runtime, mirroring the 1.2.0 startup fail-fast ([#218](https://github.com/Connectum-Framework/connectum/pull/218)).
- **Observable AMQP lifecycle** — the new discriminated `onLifecycle` callback delivers the full connection-lifecycle event union in guaranteed order ([#216](https://github.com/Connectum-Framework/connectum/pull/216)), and `AmqpTopologyError` now carries a machine-readable `.object` identifying the failing exchange/queue/binding ([#217](https://github.com/Connectum-Framework/connectum/pull/217)).
- **Broker-free AMQP testing** — the new `@connectum/events-amqp/testing` subpath ships a programmable `FakeAmqpAdapter`: FIFO publish outcomes with the real typed errors, a deterministic recovery control surface, and delivery with settlement counts ([#224](https://github.com/Connectum-Framework/connectum/pull/224)).
- **Typed adapter DI** — `@connectum/events` exports the `EventAdapterFactory` type for per-consumer adapter wiring and test seams ([#223](https://github.com/Connectum-Framework/connectum/pull/223)).
