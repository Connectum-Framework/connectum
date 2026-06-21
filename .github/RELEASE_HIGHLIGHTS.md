<!--
  Curated release highlights for the NEXT release. Maintainer-edited.
  `scripts/build-release-notes.mjs` prepends this verbatim as the "## Highlights"
  section of both the GitHub Release notes and the Version Packages PR body.
  Keep it SHORT: the few most important user-facing changes, ONE concise line
  each. The per-package sections below already carry the full detail — do NOT
  duplicate it here. Update (or clear) this file when cutting a new release.
-->
- **Internal (service-to-service) auth** — a first-class `internal` marker and `createInternalAuthInterceptor` with pluggable per-service trust (mesh identity, issuer-bound JWKS, or a dev shared-secret), so `public → internal` removes world-open exposure rather than just renaming it (ADR-029). ([#179](https://github.com/Connectum-Framework/connectum/pull/179))
- **`createCatalogClient`** — the catalog-typed `call`/`stream` ergonomics outside a `Server`, for out-of-process callers like a Temporal worker, scheduler, or CLI. ([#178](https://github.com/Connectum-Framework/connectum/pull/178))
- **EventBus broadcast & publisher topics** — `createBroadcastSubscribers` for 1→N fan-out, plus `EventBusOptions.publishes` so a publisher-only process resolves the declared topic instead of silently using the message `typeName`. ([#176](https://github.com/Connectum-Framework/connectum/pull/176), [#166](https://github.com/Connectum-Framework/connectum/pull/166))
- **`connectum --version`** now reports the real published version, read from `package.json`. ([#164](https://github.com/Connectum-Framework/connectum/pull/164))
