---
"@connectum/cli": minor
---

fix: `connectum init` and `connectum proto sync` refuse bad input up front instead of producing a broken project or a silent partial result

**BREAKING — `connectum init`:**

- The positional argument is now a destination **path**; the package name is its last segment (`init apps/payments` creates `apps/payments` with `"name": "payments"`; `init .` uses the current directory's name). Previously the whole argument was the name.
- The name must be valid for a **new npm package**. Names npm rejects or warns about (upper-case letters, whitespace, `.`/`_`/`-` at the start, `~ ' ! ( ) *`, `node_modules`, `favicon.ico`, Node.js core-module names, longer than 214 characters) are refused with a message naming the rule, before anything is written. They are not corrected silently. A name such as `a${b}c` used to end up inside a template literal of the generated `src/index.ts`; the startup log line now carries the name as an escaped string literal as well.
- `--no-sample` now does what it says: no Greeter proto, service or end-to-end test; the server starts with an empty service list; a smoke test builds the real server. Until `npx @connectum/cli generate service <name>` has run, `buf generate` has no proto file, so `typecheck`, `test` and `start` of such a project need that step first (the README and the printed next steps say so). `--no-sample` cannot be combined with `--auth` or `--events` — their demonstration slices are built on the Greeter service — and is refused with a message naming both options.

**`connectum init` (not breaking):**

- A fetched base that the transform cannot use (no or unparsable `package.json`, missing `#gen/*` / `#*` import aliases, no `tsconfig.json`, no Greeter proto / service) is reported as one list of defects instead of a raw runtime error.
- Every target is checked before the first file is written: a directory where a file goes, a file where a directory goes, a non-writable nearest parent. The message names all conflicts and nothing is written, also with `--force`.

**`connectum proto sync`:**

- Fails with a non-zero exit code and names the services when the server lists a service that reflection cannot describe (full sync and `--dry-run`); it no longer reports success on a partial descriptor set.
- Every reflection request has a time limit, 10 000 ms by default; `--timeout <ms>` (1 to 2147483647) changes it. A server that accepts the connection and never answers now ends with an error naming the address and the limit instead of hanging.
