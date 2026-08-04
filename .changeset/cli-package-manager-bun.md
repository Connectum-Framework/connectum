---
"@connectum/cli": minor
---

Accept `--package-manager bun`.

The flag previously took `pnpm` or `npm` only, which read as a gap next to a working
`--runtime bun` — but the two are independent: `bun install` lays out an ordinary
`node_modules`, so a Bun-installed project runs on Node.js and an npm-installed one
runs on Bun. The scaffold matrix already exercised the second crossing; the first
was simply unavailable.

No new file is generated for bun. The `pnpm-workspace.yaml` build-approval only
exists because pnpm 11 exits non-zero on an unapproved build script; npm runs
postinstalls by default and bun exits zero even when it blocks one.

While editing that block, its comment turned out to state the wrong reason -- it
claimed `buf generate` cannot run without the approval. It can: the buf binary
ships as an optionalDependencies platform package behind a Node shim, and the
postinstall is only a validator for the `--no-optional` case. What the approval
actually prevents is a non-zero `pnpm install`, which would break the scaffolded
project's first command. The comment now says so.
