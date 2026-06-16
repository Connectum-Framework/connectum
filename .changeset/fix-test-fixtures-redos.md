---
"@connectum/test-fixtures": patch
---

fix: bound the matched input in `assertConnectError`; align `engines.node`

`assertConnectError` now matches `messagePattern` against a 1000-char slice of the error message rather than the full string. The function already failed fast on messages longer than 1000 chars; making the bound explicit at the match site is a bounded-input mitigation (it caps the matched length, not regex complexity — the pattern is test-author controlled, not attacker input) and clears the `js/polynomial-redos` static-analysis finding. Also aligns `@connectum/test-fixtures` `engines.node` to the published consumer floor (`>=22.13.0`, was `>=20.0.0`) for consistency with the other packages.
