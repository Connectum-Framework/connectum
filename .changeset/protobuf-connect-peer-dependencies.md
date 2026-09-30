---
"@connectum/core": minor
"@connectum/auth": minor
"@connectum/events": minor
"@connectum/healthcheck": minor
"@connectum/interceptors": minor
"@connectum/otel": minor
"@connectum/reflection": minor
"@connectum/testing": minor
"@connectum/test-fixtures": minor
---

feat: declare protobuf and Connect as peer dependencies, so an application runs with one copy of each

`@bufbuild/protobuf`, `@connectrpc/connect` and `@connectrpc/connect-node` were regular dependencies. An application that pinned its own version could end up with a second copy that nothing reported: message and service types generated against one copy then stopped type-checking against the other, and a `connect-node` next to a different `connect` formed a pair `connect-node` does not support (it requires one exact `connect` version).

- `@connectum/core`, `auth`, `events`, `healthcheck`, `interceptors`, `otel`, `reflection`, `testing` and `test-fixtures` now declare `@bufbuild/protobuf` `^2.16.0` and `@connectrpc/connect` `^2.2.0` in `peerDependencies`; `core` and `testing` also declare `@connectrpc/connect-node` `^2.2.0`.
- `auth`, `events` and `interceptors` declare `@connectum/core` as a peer dependency instead of a dependency, so they use the application's own `@connectum/core`.
- `@connectum/interceptors` now depends on `@bufbuild/protovalidate` directly. The validation interceptor imports it whether or not validation is enabled; it used to install only because npm, pnpm and Bun add missing peers of `@connectrpc/validate`.
- `@connectum/cli` and `@connectum/protoc-gen-catalog` are unchanged: they are executables, and `@bufbuild/protoplugin` pins `@bufbuild/protobuf` exactly, so they keep their own copy and are outside the single-copy guarantee.

With pins inside these ranges, or no pins at all, npm, pnpm and Bun now install exactly one copy of each library for the application and every Connectum runtime package.

**BREAKING (installation):** an install that worked before can now fail or warn.

- npm refuses an application whose `@bufbuild/protobuf`, `@connectrpc/connect` or `@connectrpc/connect-node` pin is outside the ranges above, with `ERESOLVE unable to resolve dependency tree`. pnpm prints `Issues with peer dependencies found` (`pnpm peers check` names the library) and keeps the application's too-old copy; Bun warns in the same way, but may stay silent about a too-old `@bufbuild/protobuf` when a code generator such as `protoc-gen-es` brings its own in-range copy.
- Yarn does not install missing peer dependencies: Yarn users add `@bufbuild/protobuf`, `@connectrpc/connect` and `@connectrpc/connect-node` (and `@connectum/core` next to `auth`, `events` or `interceptors`) to their own `package.json`.

Under strict Semantic Versioning this is a major change, and Connectum's breaking-changes strategy does not plan breaking changes for minor versions. It ships in 1.3.0 as an explicit, recorded exception, so that applications get the single-copy fix now rather than with 2.0.

Migration: raise any pin of `@bufbuild/protobuf` to `^2.16.0` and of `@connectrpc/connect` / `@connectrpc/connect-node` to `^2.2.0`, keeping `connect` and `connect-node` on the same version — or remove the pins and let npm, pnpm or Bun install the peers. Do not work around a conflict with `--legacy-peer-deps` or `--force`: that reinstates the duplicate copies. Generate code with `protoc-gen-es` 2.16 or later.
