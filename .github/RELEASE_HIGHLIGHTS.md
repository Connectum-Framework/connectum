<!--
  Curated release highlights for the NEXT release. Maintainer-edited.
  `scripts/build-release-notes.mjs` prepends this verbatim as the "## Highlights"
  section of both the GitHub Release notes and the Version Packages PR body.
  Keep it SHORT: the few most important user-facing changes, ONE concise line
  each. The per-package sections below already carry the full detail — do NOT
  duplicate it here. Update (or clear) this file when cutting a new release.
-->
- **No identity without a usable subject** — an identity whose subject holds no character after the control characters are removed is now refused with `Unauthenticated` by every auth interceptor, whatever produced it and with or without `propagateHeaders`, and a gateway type header of control characters only now falls back to `defaultType`.
