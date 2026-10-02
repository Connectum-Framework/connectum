---
"@connectum/core": patch
"@connectum/auth": patch
"@connectum/events": patch
"@connectum/healthcheck": patch
"@connectum/interceptors": patch
"@connectum/otel": patch
"@connectum/reflection": patch
"@connectum/protoc-gen-catalog": patch
"@connectum/testing": patch
---

Clear the remaining dependency advisories, and keep one `@bufbuild/protobuf` in the
workspace.

`@bufbuild/buf` moves to 1.72.0. `@bufbuild/protoplugin` now moves together with
`@bufbuild/protobuf` and `@bufbuild/protoc-gen-es` under the single-instance pin: it
had lagged one release behind and pinned a second copy of `@bufbuild/protobuf`, which
is exactly the split the pin exists to prevent -- two instances break
`@connectrpc/connect`'s protobuf peer and the reflection DTS build. The protobuf-es and
connect-es versions this release requires are in the protobuf-es 2.16 / Connect 2.2
entry.

Several `overrides` were pinned to the version that closed an *earlier* advisory
and had since been superseded: `brace-expansion` 5.0.5 -> 5.0.9, `js-yaml` 4.2.0 ->
4.3.0 (plus a new pin for the 3.x line `@changesets/cli` pulls), `fast-uri` 3.1.2 ->
3.1.5, `basic-ftp` 5.2.2 -> 5.3.1, `protobufjs` 7.6.3 -> 7.6.5, and new pins for
`ip-address`, `linkify-it`, `undici` and `ws`. Every target is published and stays
inside the major already installed.

`pnpm audit` now reports no vulnerabilities at any severity, dev included; it
previously reported 1 critical, 21 high and 14 moderate.
