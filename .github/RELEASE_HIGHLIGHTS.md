<!--
  Curated release highlights for the NEXT release. Maintainer-edited.
  `scripts/build-release-notes.mjs` prepends this verbatim as the "## Highlights"
  section of both the GitHub Release notes and the Version Packages PR body.
  Keep it SHORT: the few most important user-facing changes, ONE concise line
  each. The per-package sections below already carry the full detail — do NOT
  duplicate it here. Update (or clear) this file when cutting a new release.
-->
- **AMQP fail-fast startup** — `@connectum/events-amqp` `failFastOnInitialSetupError` + an `onSetupFailed` hook: a permanent topology/setup error on the first connect now rejects `connect()` with a typed `AmqpTopologyError` instead of hanging silently under the default recovery (`maxRetries: Infinity`); a transient broker outage still waits and reconnects. ([#205](https://github.com/Connectum-Framework/connectum/pull/205))
- **Trustworthy AMQP reconnect signals** — `onReconnecting` fires exactly once per scheduled retry (no double-counted metrics), and in-flight publish failures are classified by connection state rather than amqplib error text, keeping the connection-loss-vs-nack / at-least-once republish decision correct across amqplib upgrades. ([#205](https://github.com/Connectum-Framework/connectum/pull/205))
