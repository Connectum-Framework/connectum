# Changelog

Connectum is a Changesets-managed monorepo. There is **no consolidated root
changelog** — the per-package files and the GitHub Releases are canonical.

- **Per-package detail** — each package keeps its own changelog, maintained
  automatically by [Changesets](https://github.com/changesets/changesets):
  [`packages/<name>/CHANGELOG.md`](packages/) (e.g.
  [`packages/core/CHANGELOG.md`](packages/core/CHANGELOG.md)).

- **Release highlights across all packages** — the GitHub Releases page,
  generated from the consumed changesets at publish time:
  <https://github.com/Connectum-Framework/connectum/releases>.

Each `@connectum/*` package is versioned together as a fixed group, so a given
release tag corresponds to the same version across every package.
