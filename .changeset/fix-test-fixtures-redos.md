---
"@connectum/test-fixtures": patch
---

fix: bound the matched input in `assertConnectError` (ReDoS-safe)

`assertConnectError` now matches the `messagePattern` against a 1000-char slice of the error message rather than the full string. The function already failed fast on messages longer than 1000 chars; making the bound explicit at the match site is defence-in-depth so a pathological caller-supplied pattern cannot incur super-linear backtracking, and clears the `js/polynomial-redos` static-analysis finding.
