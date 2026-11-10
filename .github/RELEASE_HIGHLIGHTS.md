<!--
  Curated release highlights for the NEXT release. Maintainer-edited.
  `scripts/build-release-notes.mjs` prepends this verbatim as the "## Highlights"
  section of both the GitHub Release notes and the Version Packages PR body.
  Keep it SHORT: the few most important user-facing changes, ONE concise line
  each. The per-package sections below already carry the full detail — do NOT
  duplicate it here. Update (or clear) this file when cutting a new release.
-->
- **No identity without a subject** — a `subject` or `type` that is empty only after the control characters are removed is now refused on write and read as no value (no identity, and the type `"unknown"`), where it used to be written as an empty header and read back as an identity with `subject: ""`; the reader and the gateway interceptor share that decision.
