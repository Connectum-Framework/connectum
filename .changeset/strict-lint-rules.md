---
"@connectum/core": patch
"@connectum/auth": patch
"@connectum/otel": patch
"@connectum/protoc-gen-catalog": patch
---

Internal hardening, no behaviour change: the linter now enforces a stricter rule set
(no import cycles, no namespace imports, no bitwise operators, no `== null`, no `var`,
no unguarded `for...in`, and others), and the sources were brought in line with it.

The CIDR check behind the gateway trust source is now plain integer arithmetic instead
of signed 32-bit shifts, so no prefix length can flip the high bit; every prefix
boundary, including `/0`, `/1`, `/31` and `/32`, is covered by a test. The catalog
generator emits its `catalog.gen.ts` through `print(...)` calls rather than tagged
templates; a test pins the exact generated text line for line.
