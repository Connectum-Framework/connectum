---
"@connectum/core": patch
---

fix: the `Fix:` line of `PeerDependencyVersionError` now names the file and field each package manager reads to force one in-range version: `overrides` in `package.json` for npm and Bun, `resolutions` in `package.json` for Yarn, and `overrides` in `pnpm-workspace.yaml` for pnpm 11 and later. The old text said only `pnpm "overrides"`, and a pnpm user who put it in the `pnpm` field of `package.json` got a warning that pnpm ignores the field, with the old protobuf copy still installed.
