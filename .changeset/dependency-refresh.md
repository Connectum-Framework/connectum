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

Update protobuf-es to 2.13.0 and clear the remaining dependency advisories.

`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and `@bufbuild/protoplugin` move to
2.13.0, and `@bufbuild/buf` to 1.72.0. The single-instance pin moves with them:
`@bufbuild/protoplugin` was still on 2.12.1 and pinned a second copy of
`@bufbuild/protobuf`, which is exactly the split the pin exists to prevent -- two
instances break `@connectrpc/connect`'s protobuf peer and the reflection DTS build.
The workspace now resolves a single 2.13.0.

connect-es is unchanged: `@connectrpc/connect` and `@connectrpc/connect-node` 2.1.2
are already the latest published releases.

Several `overrides` were pinned to the version that closed an *earlier* advisory
and had since been superseded: `brace-expansion` 5.0.5 -> 5.0.9, `js-yaml` 4.2.0 ->
4.3.0 (plus a new pin for the 3.x line `@changesets/cli` pulls), `fast-uri` 3.1.2 ->
3.1.5, `basic-ftp` 5.2.2 -> 5.3.1, `protobufjs` 7.6.3 -> 7.6.5, and new pins for
`ip-address`, `linkify-it`, `undici` and `ws`. Every target is published and stays
inside the major already installed.

`pnpm audit` now reports no vulnerabilities at any severity, dev included; it
previously reported 1 critical, 21 high and 14 moderate.
