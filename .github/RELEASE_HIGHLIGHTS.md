<!--
  Curated release highlights for the NEXT release. Maintainer-edited.
  `scripts/build-release-notes.mjs` prepends this verbatim as the "## Highlights"
  section of both the GitHub Release notes and the Version Packages PR body.
  Keep it to the few most important user-facing changes (newest release).
  Update (or clear) this file when cutting a new release.
-->
- **`EventBus.publishes` — correct topic for publisher-only processes** — a process that publishes an event without subscribing to it has no `routes`, so `publish()` previously fell back to the message `typeName` and silently emitted to the wrong topic whenever the event declared a custom `(connectum.events.v1.event).topic`. List the event service descriptors in the new `EventBusOptions.publishes` and the declared topic is resolved from the proto option end-to-end — no hand-maintained raw topic strings. ([#166](https://github.com/Connectum-Framework/connectum/pull/166))
- **`connectum --version` reports the real published version** — the CLI now reads its version from `package.json` instead of a hand-maintained string that had drifted from the actual release. ([#164](https://github.com/Connectum-Framework/connectum/pull/164))
