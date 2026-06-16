---
"@connectum/testing": patch
---

fix: make `@connectum/testing/parity` importable by preserving the `node:` protocol prefix

tsup strips the `node:` prefix from builtin imports by default (`removeNodeProtocol: true`). For `node:test` that is fatal — the unprefixed `test` has no bare builtin equivalent, so the published `dist/parity.js` shipped `import { test } from "test"` and threw `Cannot find package 'test'` in every consumer of the `./parity` subpath. Setting `removeNodeProtocol: false` keeps `node:test` (and other builtins) intact; the consumer floor is Node >=22.13 where the prefix is required for `node:test` and supported for every builtin.
