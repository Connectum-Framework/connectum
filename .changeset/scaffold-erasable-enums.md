---
"@connectum/cli": patch
---

`connectum init`: projects with Protobuf enums now type-check and run under native type stripping.

A scaffolded project runs `node src/index.ts` with Node's native type stripping and type-checks with `erasableSyntaxOnly`, and both reject a TypeScript `enum`. protoc-gen-es emitted one for every Protobuf enum, so the first enum a user added broke `start` (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) and `typecheck` (TS1294).

- The generated `buf.gen.yaml` passes `erasable_syntax=true` to protoc-gen-es (not to the catalog plugin, which rejects unknown options). An enum is generated as an `as const` object plus a type of the same name: `Color.RED` works as before, there is no reverse mapping (`Color[1]`), a single value's type is `typeof Color.RED`, and an open enum's type also admits `UnknownEnum`.
- The scaffolded `package.json` declares `@bufbuild/protobuf` and `@bufbuild/protoc-gen-es` at `^2.16.0` or higher, whatever the fetched base declares, so `connectum init --ref <older base>` also produces a project that can use the erasable output. A base that already declares a higher range keeps it.
