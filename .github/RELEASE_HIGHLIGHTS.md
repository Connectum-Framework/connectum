<!--
  Curated release highlights for the NEXT release. Maintainer-edited.
  `scripts/build-release-notes.mjs` prepends this verbatim as the "## Highlights"
  section of both the GitHub Release notes and the Version Packages PR body.
  Keep it SHORT: the few most important user-facing changes, ONE concise line
  each. The per-package sections below already carry the full detail — do NOT
  duplicate it here. Update (or clear) this file when cutting a new release.
-->

- Per-object authorization in the contract: declare `resources { action, id_field, type }` on a method and `createProtoAuthzInterceptor` asks your `resourceAuthorizer` (OpenFGA, SpiceDB, OPA, Cedar, Cerbos or your own) before the handler runs, instead of every handler repeating the check.
