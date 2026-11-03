---
"@connectum/core": patch
---

fix(deps): `@connectum/core` now requires `zod` `^4.6.6` (was `^4.4.3`). Earlier 4.x releases are affected by a published security advisory (GHSA-mrhx-c7xc-m3w5), so installs that still resolve an older `zod` for the environment schema are upgraded. The environment schema and its validation error messages behave the same.
