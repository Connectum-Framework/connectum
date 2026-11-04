# @connectum/cli

## 1.3.0

### Minor Changes

- [#647](https://github.com/Connectum-Framework/connectum/pull/647) [`b42f9ca`](https://github.com/Connectum-Framework/connectum/commit/b42f9ca105e071a2f672318a36dc9e8112e6d6b6) Thanks [@intech](https://github.com/intech)! - feat: `connectum generate service` checks the project before it writes anything. A directory without a `package.json` is refused (`Error: connectum generate service: no package.json in "...". Run the command in the root of a Connectum project`), and so is `--with-events` in a project whose `package.json` lists `@connectum/events` in none of `dependencies`, `devDependencies`, `peerDependencies` and `optionalDependencies`. Before, the files were written into any directory, and the event handler of a project without the events module failed `tsc` with `TS2307` and `TS7006`. Both refusals are one line, exit code 1, and leave the directory untouched. Run the command from the project root; to use `--with-events`, add `@connectum/events` and an adapter first, or scaffold the project with `connectum init --events <adapter>`.

- [#647](https://github.com/Connectum-Framework/connectum/pull/647) [`b42f9ca`](https://github.com/Connectum-Framework/connectum/commit/b42f9ca105e071a2f672318a36dc9e8112e6d6b6) Thanks [@intech](https://github.com/intech)! - feat: `connectum init`, `connectum proto sync` and `connectum generate service` now refuse a flag they do not define and `connectum init` refuses `--node-exec` together with `--runtime bun`. Before, a mistyped flag was dropped without a word: `init --evnts nats` produced a project without events, and `proto sync --dryrun` ran the real sync instead of the dry run. The refusal is one line, `Error: connectum init: unknown option --evnts. Valid options: ...`, with exit code 1 and nothing written. `--node-exec` used with Bun had no effect (Bun runs TypeScript itself) and now fails with a message naming both flags; leave `--node-exec` out when scaffolding for Bun. Scripts that passed a flag the command never had must drop it.

- [#313](https://github.com/Connectum-Framework/connectum/pull/313) [`76ef75c`](https://github.com/Connectum-Framework/connectum/commit/76ef75c6bc9b21630527a9de28ba42257d1a55b8) Thanks [@intech](https://github.com/intech)! - fix: `connectum init` and `connectum proto sync` refuse bad input up front instead of producing a broken project or a silent partial result
  
  **`connectum init`:**
  
  - The positional argument is a destination **path**; the package name is its last segment (`init apps/payments` creates `apps/payments` with `"name": "payments"`; `init .` uses the current directory's name).
  - The name must be valid for a **new npm package**. Names npm rejects or warns about (upper-case letters, whitespace, `.`/`_`/`-` at the start, `~ ' ! ( ) *`, `node_modules`, `favicon.ico`, Node.js core-module names, longer than 214 characters) are refused with a message naming the rule, before anything is written. They are not corrected silently. A name such as `a${b}c` would otherwise end up inside a template literal of the generated `src/index.ts`; the startup log line carries the name as an escaped string literal.
  - `--no-sample` produces a real config-only project: no Greeter proto, service or end-to-end test; the server starts with an empty service list; a smoke test builds the real server. Until `npx @connectum/cli generate service <name>` has run, `buf generate` has no proto file, so `typecheck`, `test` and `start` of such a project need that step first (the README and the printed next steps say so). `--no-sample` cannot be combined with `--auth` or `--events` — their demonstration slices are built on the Greeter service — and is refused with a message naming both options.
  - A fetched base that the transform cannot use (no or unparsable `package.json`, missing `#gen/*` / `#*` import aliases, no `tsconfig.json`, no Greeter proto / service) is reported as one list of defects instead of a raw runtime error.
  - Every target is checked before the first file is written: a directory where a file goes, a file where a directory goes, a non-writable nearest parent. The message names all conflicts and nothing is written, also with `--force`.
  
  **`connectum proto sync`:**
  
  - Fails with a non-zero exit code and names the services when the server lists a service that reflection cannot describe (full sync and `--dry-run`); it no longer reports success on a partial descriptor set.
  - Every reflection request has a time limit, 10 000 ms by default; `--timeout <ms>` (an integer from 1 to 99999999 written in plain decimal digits, the first one 1 to 9, so `007` is refused) changes it. A server that accepts the connection and never answers ends with an error naming the address and the limit instead of hanging.

- [#395](https://github.com/Connectum-Framework/connectum/pull/395) [`c17d85c`](https://github.com/Connectum-Framework/connectum/commit/c17d85caba4bda9700463b3b19ada4e23f4a7562) Thanks [@intech](https://github.com/intech)! - fix: the resilience interceptors and `createDefaultInterceptors` refuse option values that used to run with silently different behaviour, and the bulkhead refusal text states its limits.
  
  **BREAKING** (shipped as minor on purpose: the `@connectum/*` packages are one fixed version group, so a major here would release every package as 2.0.0):
  
  - **Numeric options are validated when the factory is called.** `createTimeoutInterceptor` `duration` is an integer from 1 to 2147483647 ms; `createBulkheadInterceptor` `capacity` is an integer >= 1 and `queueSize` an integer >= 0; `createCircuitBreakerInterceptor` `threshold` is an integer >= 1 and `halfOpenAfter` an integer from 0 to 2147483647 ms; `createRetryInterceptor` `initialDelay` and `maxDelay` are integers from 0 to 2147483647 ms. A fractional value, or a delay above 2147483647 ms (the platform timer fires such a timer after 1 ms, so a "very long" timeout used to expire at once), now throws. A value that is not a number throws `TypeError`; a number outside the rule throws `RangeError`; the message names the factory, the option, the rule and the received value. Before, every refusal was a plain `Error`. `maxRetries` keeps accepting the same values (a fraction such as `0.5` is still valid); only the error class for an invalid one changes to `RangeError` / `TypeError`.
  - **`createDefaultInterceptors({ fallback: true })` throws `TypeError`** instead of being ignored; the type of `fallback` is now `false | FallbackOptions`. `createFallbackInterceptor` without a `handler` throws `TypeError` instead of `Error`.
  - **A value that is not understood no longer disables an interceptor.** For every key of `createDefaultInterceptors` except `validation`, only `true`, `false`, `undefined` or an options object is accepted; `validation` accepts only a boolean. `null`, a number, a string, an array or a function throws `TypeError` naming the key (`timeout must be true, false or an options object, got null`).
  - **`connectum init --resilience fallback` is refused** with the existing `invalid --resilience` message and a hint: a fallback needs an application-specific handler, so add `createFallbackInterceptor({ handler })` to `src/server.ts`. The accepted values are `timeout`, `bulkhead`, `circuitBreaker` and `retry`. Before, the flag scaffolded `fallback: true`, which did nothing.
  
  Also changed, not a contract: the bulkhead refusal text is now `Bulkhead capacity exceeded (capacity: N, queueSize: M)` with the configured limits; it used to print the policy's free slots under the label `active`, so a full bulkhead read as idle. The code stays `ResourceExhausted`; branch on the code, not on the text.
  
  **Migration.** Round fractional values and cap long delays at 2147483647 ms (about 24.8 days); for "no time limit" omit `timeout` instead of passing a huge number. Replace `fallback: true` with `fallback: { handler }` or remove it, and replace `null`, `0` and other non-object values of a `createDefaultInterceptors` key with `false` (disabled), `true` (defaults) or an options object. Remove `fallback` from `--resilience` and add the interceptor by hand. If anything matches on the old bulkhead text, match the `ResourceExhausted` code. See the interceptor options migration guide.

- [#284](https://github.com/Connectum-Framework/connectum/pull/284) [`b85184a`](https://github.com/Connectum-Framework/connectum/commit/b85184a1b3cd61833e52c8c8aabd880ee4b1f85b) Thanks [@intech](https://github.com/intech)! - Generated code can import Connectum's option descriptors from the packages, and `connectum init` no longer generates its own copies.
  
  - `@connectum/auth` exports `./gen/connectum/auth/v1/options_pb.js` (`file_connectum_auth_v1_options`, `method_auth`, `service_auth`, the `MethodAuth` / `ServiceAuth` / `AuthRequirements` schemas and types), and `@connectum/events` exports `./gen/connectum/events/v1/options_pb.js` (`file_connectum_events_v1_options`, `event`, the `EventOptions` schema and type). Each subpath is the module the package itself uses, so a package evaluates its option proto once and hands out the same descriptor objects through every entry. Point protoc-gen-es (2.15.0 or later) at them with `map_imports=connectum/auth/v1/:@connectum/auth/gen` / `map_imports=connectum/events/v1/:@connectum/events/gen`. `@connectum/events` is now built with code splitting, so its `dist/index.js` imports a shared chunk.
  - `connectum init --auth` / `--events`: the generated `buf.gen.yaml` compiles Connectum's option protos without generating them (one `directory: proto` input, the vendored events option proto under `exclude_paths`) and maps their imports to the packages, so `gen/` no longer holds `connectum/{auth,events}/v1/options_pb.ts`. Every `@connectum/*` dependency of such a project is set to one range: the highest `@connectum/*` requirement of the fetched base, or `^1.3.0` if that is higher (also with `--ref`), so no base entry is lowered. Projects without auth or events are generated exactly as before. Existing projects keep working unchanged.

- [#229](https://github.com/Connectum-Framework/connectum/pull/229) [`8ed62cf`](https://github.com/Connectum-Framework/connectum/commit/8ed62cfaaf96cb2f08cadf3db9d0ab9c1b70b236) Thanks [@intech](https://github.com/intech)! - feat: `connectum init` and `connectum generate service` — project scaffolding
  
  - **`connectum init`** scaffolds a production-ready standalone project, interactively (a `@clack/prompts` wizard) or fully from flags (`--yes` / CI / non-TTY). The base is fetched from the dogfooded `getting-started` example via a degit-style clone, so the starter layout stays in sync with a tested example instead of a drift-prone template copy; the selected modules are composed on top.
  - **Modules:** OpenTelemetry (`--otel`), EventBus with an adapter (`--events nats|kafka|redpanda|redis|amqp`), auth (`--auth`, JWT + proto-driven authorization), service catalog (`--catalog`, typed `ctx.call`/`ctx.stream`), opt-in resilience interceptors (`--resilience timeout,retry,...`), and health/reflection toggles. Runtime (`node`/`bun`), package manager (`pnpm`/`npm`/`bun`) and the Node execution model (`raw` `.ts` >= 25.2 vs `tsx` >= 22.13) are all first-class choices.
  - **Deterministic interceptor order.** When several interceptor-adding modules are selected the composition root emits one canonical chain (outermost → innermost): OpenTelemetry → error handler → auth → validation → resilience → custom, with exactly one error handler.
  - **Lifecycle fix baked in.** `buf generate` is chained into the generated `start` / `test` / `typecheck` scripts (not a pnpm `pre*` hook, which silently no-ops), so a fresh clone never fails with an unresolved `#gen/...` import. Standalone pnpm projects also get the `buf` build-approval that pnpm 11 requires.
  - **`connectum generate service <name>`** adds a service to an existing project: a starter proto plus a `defineService` skeleton whose rpc handlers throw `Code.Unimplemented` (a deliberate, documented trade-off — the handler-map key must still exist, so a later proto method addition remains a compile error). `--with-events` also scaffolds an event-handler service and an ack-by-default `EventRoute`. It never edits your `src/server.ts`; it prints the exact registration to add.
  - **Lint rules stay on.** The generated `buf.yaml` uses the STANDARD `buf lint` rules and excepts `SERVICE_SUFFIX` and the three `RPC_*` naming and uniqueness rules only when the EventBus module is enabled, because only event-handler services break them. An except applies to the whole `proto` module, so `--auth` and the plain project lint the services you add with the full rule set.
  - **Generated tests are runtime-agnostic**: the e2e test uses the public in-process `createLocalClient` from `@connectum/testing` (no socket, identical on Node and Bun); event-enabled projects also get a broker-free `MemoryAdapter` smoke test.
  - A CI scaffold matrix (`cli-scaffold-matrix`) scaffolds each named module combination and runs `buf generate` → typecheck → test, so a broken fragment fails CI.

### Patch Changes

- [#647](https://github.com/Connectum-Framework/connectum/pull/647) [`b42f9ca`](https://github.com/Connectum-Framework/connectum/commit/b42f9ca105e071a2f672318a36dc9e8112e6d6b6) Thanks [@intech](https://github.com/intech)! - fix: a project scaffolded with `connectum init --auth` now serves the gRPC Health and reflection services without credentials, as its `src/auth.ts` already claimed. The file listed `grpc.health.v1.Health/*` and `grpc.reflection.v1.ServerReflection/*` in the JWT interceptor's `skipMethods` but gave the deny-by-default proto authorizer no rule for them, so `grpc.health.v1.Health/Check` and every reflection call answered `unauthenticated` and `connectum proto sync` failed against the project. The generated file now also allows them with an unconditional authorization rule, covers the `v1alpha` reflection service older clients use, and lists only the protocols the project mounts (`--no-healthcheck`, `--no-reflection`). Every other method stays denied without a token. Projects already scaffolded keep their `src/auth.ts`; to open the services there, add the same patterns to `createProtoAuthzInterceptor({ rules: [...] })` with `effect: AuthzEffect.ALLOW`.

- [#417](https://github.com/Connectum-Framework/connectum/pull/417) [`93b125f`](https://github.com/Connectum-Framework/connectum/commit/93b125fe672a49219ce20491fdfde41cf09f4f32) Thanks [@intech](https://github.com/intech)! - `connectum generate service <name>` now refuses a name it used to change silently, before it creates any file or directory and with a non-zero exit code.
  
  The command derives the proto package, the proto service, the TypeScript binding and two file paths from the name by keeping only ASCII letters and digits, so `../x` produced `x`, `a/b` produced `ab`, `Привет-billing` produced `billing`, and `Order Service` produced `OrderServiceService`. A name is now refused when it contains anything but ASCII letters, digits, `-` and `_` (path separators, dots, inner whitespace, non-ASCII letters), does not start with a letter, or is longer than 214 characters (a 300-character name used to end in a raw `ENAMETOOLONG` error and left an empty `proto/` directory). The message names the name and every rule it breaks, in the way `connectum init` does for a project name. No name could write outside the project directory before this change; that was checked and is not what is fixed here.
  
  Two names that map onto the same proto package (`ab`, then `a-b`) used to write a service module that imports a service the kept proto does not declare, and the project stopped compiling with exit code 0. The command now refuses that case, naming the proto and the missing service; repeating the same name is still a no-op, and `--force` overwrites.

- [#229](https://github.com/Connectum-Framework/connectum/pull/229) [`8ed62cf`](https://github.com/Connectum-Framework/connectum/commit/8ed62cfaaf96cb2f08cadf3db9d0ab9c1b70b236) Thanks [@intech](https://github.com/intech)! - Fetch the `init` base project with `giget` instead of `tiged`.
  
  `tiged` depends on `tar`, and the releases it pins (`^6.1.11`) carry a critical
  decompression denial-of-service advisory and a high-severity arbitrary
  file-overwrite advisory. `tiged@2.12.8` is its latest release, so upgrading does not
  reach a fixed `tar` — the constraint is in `tiged` itself. That matters more here
  than it would elsewhere: a scaffolder exists to download and unpack a remote
  archive, so the extraction path is exactly the exposed one.
  
  `giget` is the maintained degit-style downloader from the same project family as
  `citty`, which this CLI already uses, and it has **no dependencies at all**. The
  change removes the critical and both high advisories from the CLI's production
  dependency closure and drops nine transitive packages.
  
  The fetcher was already injectable behind `CloneFn`, so the change is confined to
  the default implementation. The only externally visible difference is the spec
  format: giget needs its `gh:` provider prefix, so the base is now requested as
  `gh:Connectum-Framework/examples/getting-started#<ref>`. `connectum init` was run
  end to end against the real repository to confirm it.

- [#647](https://github.com/Connectum-Framework/connectum/pull/647) [`b42f9ca`](https://github.com/Connectum-Framework/connectum/commit/b42f9ca105e071a2f672318a36dc9e8112e6d6b6) Thanks [@intech](https://github.com/intech)! - fix: `connectum init --no-healthcheck` no longer leaves anything that calls the health endpoint. `Dockerfile` and `Dockerfile.bun` lose the `HEALTHCHECK` that probed `/healthz` (and the `curl` install made for it), and `package.json` no longer depends on `@connectum/healthcheck`. Before, a project scaffolded without the health protocol shipped a container that Docker would mark unhealthy once the start period ended, because `/healthz` answers 404 when the protocol is not mounted.

- [#279](https://github.com/Connectum-Framework/connectum/pull/279) [`7001ec7`](https://github.com/Connectum-Framework/connectum/commit/7001ec724118f6268923d873cd69d6953d44eebd) Thanks [@intech](https://github.com/intech)! - `connectum init --package-manager pnpm --otel` no longer produces a project whose first
  `pnpm install` fails.
  
  pnpm 11 and later exit with `ERR_PNPM_IGNORED_BUILDS` when any dependency has a build
  script that the project neither approves nor denies. The OpenTelemetry module pulls in
  `protobufjs` (through the OTLP gRPC exporters), which declares a `postinstall`, and the
  generated `pnpm-workspace.yaml` did not list it, so the install stopped with exit code 1.
  
  The generated `allowBuilds` map now lists every package with a build script that any
  module combination installs: `@bufbuild/buf` and `esbuild` stay approved (their scripts
  locate or download the platform binary the project needs), and `protobufjs` is denied
  explicitly — its script only prints a version-prefix warning and has no runtime effect.
  Projects already scaffolded can add `protobufjs: false` under `allowBuilds` in their
  `pnpm-workspace.yaml`.

- [#403](https://github.com/Connectum-Framework/connectum/pull/403) [`cbc4687`](https://github.com/Connectum-Framework/connectum/commit/cbc4687887c32f78d21736c2c12f70052a60b848) Thanks [@intech](https://github.com/intech)! - fix: `connectum proto sync --from` decides whether it got a URL by the shape of the address, not by its first letters
  
  - A bare `host:port` always gets `http://` in front of it. Before, any address whose host name merely began with the letters `http` (`httpbin.local:5000`, `https-proxy.internal:443`) was passed on without a scheme and failed with `Invalid URL`.
  - An address that starts with `http://` or `https://` is used exactly as typed; the scheme may be written in any letter case.
  - An address with any other scheme (`ftp://h:5`, `grpc://h:5`) is refused before a connection is attempted, with a message that names the scheme and lists the accepted forms (`host:port`, `http://...`, `https://...`). Before, it became `http://ftp://h:5` and failed with a resolver error that did not mention the scheme.

- [#647](https://github.com/Connectum-Framework/connectum/pull/647) [`b42f9ca`](https://github.com/Connectum-Framework/connectum/commit/b42f9ca105e071a2f672318a36dc9e8112e6d6b6) Thanks [@intech](https://github.com/intech)! - fix: `connectum proto sync` against a server that only speaks HTTP/1.1 now says so. `createServer()` leaves `allowHTTP1` on by default, which on plain TCP makes the server HTTP/1.1-only, and the command talks gRPC over HTTP/2; the failure used to read `ConnectError: [internal] Protocol error` with a stack trace and no address. It is now `Error: HTTP/2 protocol error talking to http://localhost:5311 (Protocol error). The address probably serves HTTP/1.1 only ... unless it is created with allowHTTP1: false.`

- [#647](https://github.com/Connectum-Framework/connectum/pull/647) [`b42f9ca`](https://github.com/Connectum-Framework/connectum/commit/b42f9ca105e071a2f672318a36dc9e8112e6d6b6) Thanks [@intech](https://github.com/intech)! - fix: `connectum proto sync` reports the failures a user meets most often as one line (`Error: ...`, exit code 1) instead of a raw error object with a stack trace. A closed port names the address and the reason (`Cannot connect to http://localhost:1: ECONNREFUSED`); an empty `--from` and one that is not a URL (`local host:5305`) are refused by name before the command connects; a missing `buf` says it is not on the PATH and links the install page; a `buf generate` that fails names its exit code after its own output; and a `--template` that is not an existing file is refused before the command connects, where it used to fail only after the descriptors were fetched. A server that answers with an error is reported with its address and the server's own message (`Reflection request to http://localhost:5000 failed: [unauthenticated] ...`). The error classes of `fetchReflectionData` and `fetchFileDescriptorSetBinary` are unchanged apart from being `CliError` (an `Error` subclass) where they were plain `Error`.

- [#404](https://github.com/Connectum-Framework/connectum/pull/404) [`2f61509`](https://github.com/Connectum-Framework/connectum/commit/2f61509041a91dcadb71fa9f1ee6b471e9b180fc) Thanks [@intech](https://github.com/intech)! - fix: `connectum proto sync` removes its temporary directory when writing the descriptor file fails
  
  The directory was created and the file written before the block that removes the directory, so a failed write (disk full, permissions) left `connectum-proto-sync-*` behind in the system temporary directory. The write now happens inside that block. Present in 1.2.0.

- [#647](https://github.com/Connectum-Framework/connectum/pull/647) [`b42f9ca`](https://github.com/Connectum-Framework/connectum/commit/b42f9ca105e071a2f672318a36dc9e8112e6d6b6) Thanks [@intech](https://github.com/intech)! - fix: the README that `connectum init` writes now says what a project needs before `start`. A project scaffolded with `--auth` gets an Authentication section naming `JWKS_URI`, `JWT_ISSUER` and `JWT_AUDIENCE` (with the JWKS default) and which sample method needs a token; one scaffolded with `--events <adapter>` gets an Events section naming the broker, the variable that holds its address and the default (`NATS_SERVERS`, `KAFKA_BROKERS`, `REDPANDA_BROKERS`, `REDIS_URL`, `AMQP_URL`), and for NATS, Redis and RabbitMQ a `docker run` line with the image the repository's CI runs the adapter against. Before, the README was the same for every combination and an `--events nats` project exited at startup with `connection refused` and no hint why. A project without those modules gets the README it had.

- [#353](https://github.com/Connectum-Framework/connectum/pull/353) [`af9c66c`](https://github.com/Connectum-Framework/connectum/commit/af9c66c5ad7d8b405cf49003d1ec24c3927da138) Thanks [@intech](https://github.com/intech)! - fix: the README that `connectum init` writes now says that a service added with `connectum generate service <name>` is a stub whose handler throws `Unimplemented` until it is replaced with real logic; before, a first call to the generated service failed with no hint in the project.

- [#651](https://github.com/Connectum-Framework/connectum/pull/651) [`70b91ca`](https://github.com/Connectum-Framework/connectum/commit/70b91caeffef5753cef81dccd1bfe2fdd7b50a93) Thanks [@intech](https://github.com/intech)! - fix: every package manifest now carries `homepage` (the package page on https://connectum.dev), `bugs.url` (the repository issue tracker) and one `repository` form (`git+https://github.com/Connectum-Framework/connectum.git` plus the package `directory`). Before, none of the 15 packages declared `homepage` or `bugs`, so the npm package page had no documentation or issue links and `npm docs` / `npm bugs` had nothing to open; the four events adapters also wrote `repository.url` without the `git+` prefix. The release gate now fails if any installed package differs from this form.

- [#283](https://github.com/Connectum-Framework/connectum/pull/283) [`0cc15bb`](https://github.com/Connectum-Framework/connectum/commit/0cc15bb38fe23d8e9ac1a4b669b97c0b496d5e76) Thanks [@intech](https://github.com/intech)! - Serve gRPC Server Reflection with Connectum's own implementation and drop `@lambdalisue/connectrpc-grpcreflect`.
  
  That package declared `@bufbuild/protobuf` and `@connectrpc/connect` as regular dependencies, so a package manager could install a private protobuf copy for it next to the application's. `@connectum/reflection` and the reflection client behind `connectum proto sync` now use code generated from the upstream `grpc.reflection.v1` / `v1alpha` protos, with no third-party reflection package. The public API is unchanged.
  
  Responses now follow the reflection protocol where the previous implementation did not:
  
  - `grpcurl describe pkg.Service.Method` works: `file_containing_symbol` resolves methods, fields, oneofs, enum values, map entries and extensions, not only types and services.
  - File answers carry the requested file and its transitive imports (well-known types included), without repeating files already sent on the same stream.
  - `all_extension_numbers_of_type` fills `base_type_name` and lists numbers in ascending order; an unknown type is `NOT_FOUND` instead of an empty list.
  - A not-found extension names the type and number instead of `File not found: [object Object]`.
  - A request with no query set gets an `INVALID_ARGUMENT` error response instead of an empty one; the stream stays open.
  - `list_services` lists the mounted services only: not services declared in a file that is merely imported, nor the unmounted services of a file that also declares a mounted one.
  
  `connectum proto sync` and `@connectum/cli/utils/reflection` return the same file order and descriptor-set bytes as before (the service list changes only as described above), and still fall back to v1alpha for servers without v1.

- [#325](https://github.com/Connectum-Framework/connectum/pull/325) [`3591014`](https://github.com/Connectum-Framework/connectum/commit/35910149aa614a388cfadbb11968b3deb57aad13) Thanks [@intech](https://github.com/intech)! - docs: the package READMEs are short entry points (install, a runnable start, constraints, links) and the long reference tables now live on the documentation site and in the API reference. The facts that exist only in a README stay there: the cancellation migration notes of `@connectum/interceptors`, the request initializer migration of `@connectum/protoc-gen-catalog`, the dependency injection and testing section of `@connectum/events`, the verified RabbitMQ and Kafka broker lines and the integration-suite instructions of the AMQP and Kafka adapters. Examples in the READMEs of eight packages and the Quickstart are executed against the packed packages by `pnpm docs:check`. JSDoc of a few exports was corrected to match the code; no runtime behavior changes.

- [#277](https://github.com/Connectum-Framework/connectum/pull/277) [`90a5a5f`](https://github.com/Connectum-Framework/connectum/commit/90a5a5fcddb895b8ca2b5a922ea5ca54bdad6ba5) Thanks [@intech](https://github.com/intech)! - Require `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and `@bufbuild/protoplugin` `^2.16.0` and `@connectrpc/connect` / `@connectrpc/connect-node` `^2.2.0`. Generate your code with `protoc-gen-es` 2.16 and keep one `@bufbuild/protobuf` version in your project. When an application pins an older `@bufbuild/protobuf` than the one Connectum resolves, two copies get installed, and message and service types generated against one copy no longer match the other.

- [#280](https://github.com/Connectum-Framework/connectum/pull/280) [`249616f`](https://github.com/Connectum-Framework/connectum/commit/249616fb3d5e3d0eae1ec6ee7c4eeb035ddb58a5) Thanks [@intech](https://github.com/intech)! - `connectum init`: projects with Protobuf enums now type-check and run under native type stripping.
  
  A scaffolded project runs `node src/index.ts` with Node's native type stripping and type-checks with `erasableSyntaxOnly`, and both reject a TypeScript `enum`. protoc-gen-es emitted one for every Protobuf enum, so the first enum a user added broke `start` (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) and `typecheck` (TS1294).
  
  - The generated `buf.gen.yaml` passes `erasable_syntax=true` to protoc-gen-es (not to the catalog plugin, which rejects unknown options). An enum is generated as an `as const` object plus a type of the same name: `Color.RED` works as before, there is no reverse mapping (`Color[1]`), a single value's type is `typeof Color.RED`, and an open enum's type also admits `UnknownEnum`.
  - The scaffolded `package.json` declares `@bufbuild/protobuf` and `@bufbuild/protoc-gen-es` at `^2.16.0` or higher, whatever the fetched base declares, so `connectum init --ref <older base>` also produces a project that can use the erasable output. A base that already declares a higher range keeps it.

- [#292](https://github.com/Connectum-Framework/connectum/pull/292) [`b555978`](https://github.com/Connectum-Framework/connectum/commit/b5559789145656d823b9277f0406e51a14c6251a) Thanks [@intech](https://github.com/intech)! - Each package now evaluates its modules once, whichever subpath you import.
  
  These packages were built with one bundle per subpath, and every bundle carried its own copy of the modules it used. In `@connectum/otel` that meant one provider singleton per subpath: `getProvider()` from `@connectum/otel` and from `@connectum/otel/provider` returned different providers, and the second one's global registration failed with `Attempted duplicate registration of API: trace`, so a tracer or meter taken through a subpath belonged to a provider OpenTelemetry was not using. Likewise `ServerState` from `@connectum/core` and `@connectum/core/types` were two objects, and collectors created by `@connectum/testing/parity` were not `instanceof` the classes exported by `@connectum/testing`.
  
  The builds now share modules between subpaths, so every subpath hands out the same provider, classes and functions. The `exports` maps are unchanged; `dist` gains shared chunk files.

## 1.2.0

## 1.1.0

### Patch Changes

- [#164](https://github.com/Connectum-Framework/connectum/pull/164) [`c7d299e`](https://github.com/Connectum-Framework/connectum/commit/c7d299ea3d229a5c05e5f9ad9e51e75a21818d62) Thanks [@intech](https://github.com/intech)! - Read the CLI version from `package.json` so `connectum --version` always reports the real published release. It previously printed a hand-maintained string (`0.2.0-alpha.2`) that had drifted from the actual package version.

- [#184](https://github.com/Connectum-Framework/connectum/pull/184) [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae) Thanks [@intech](https://github.com/intech)! - Bump protobuf-es (`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`, `@bufbuild/protoplugin`) to 2.12.1. A workspace `overrides` entry pins `@bufbuild/protobuf` to a single version so transitive consumers (`@lambdalisue/connectrpc-grpcreflect`, `@bufbuild/protovalidate`) don't split `@connectrpc/connect`'s protobuf peer into two incompatible instances. Generated code is unchanged; published packages now declare `@bufbuild/protobuf` `^2.12.1`.

## 1.0.0

### Major Changes

- [#129](https://github.com/Connectum-Framework/connectum/pull/129) [`4cef99b`](https://github.com/Connectum-Framework/connectum/commit/4cef99b469f7399993319a436fa11fd4747ffd2f) Thanks [@intech](https://github.com/intech)! - chore: raise minimum supported Node.js to 22.13.0

  The `engines.node` requirement for all packages is raised from `>=20.0.0` to
  `>=22.13.0`. Node.js 20 reached end-of-life on 2026-04-30 and no longer receives
  security updates.

  Node.js 22 is the current LTS line. Consumers on Node.js 20 or earlier must
  upgrade to Node.js 22.13.0 or later. Packages continue to ship compiled
  JavaScript, so no build-step changes are required on the consumer side.

  Marked as a major change because raising the runtime floor is breaking for
  consumers on Node.js 20; it lands in the upcoming 1.0.0 baseline.

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

### Patch Changes

- [#70](https://github.com/Connectum-Framework/connectum/pull/70) [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda) Thanks [@intech](https://github.com/intech)! - Comprehensive test coverage improvements across 10 packages (+225 tests).

  **New test files:**

  - `core/envSchema.test.ts` — env config validation (50 tests)
  - `core/server-lifecycle.test.ts` — server integration with eventBus, protocols, shutdown (24 tests)
  - `auth/errors.test.ts` — AuthzDeniedError (14 tests)
  - `auth/authz-utils.test.ts` — satisfiesRequirements() (12 tests)
  - `cli/proto-sync.test.ts` — CLI unit tests (33 tests, was 4 integration-only)
  - `events/topic.test.ts` — resolveTopicName() (3 tests)
  - `healthcheck/healthcheck-grpc.test.ts` — gRPC Health Check + HTTP E2E (11 tests)

  **Extended existing tests:**

  - `core` — Server state transitions, ShutdownManager deps/cycles, graceful shutdown edge cases (+17)
  - `healthcheck` — gRPC handlers, manager merge, HTTP handler scenarios (+17)
  - `reflection` — circular deps, empty registry, multiple services (+6)
  - `interceptors` — error handler, timeout, retry, bulkhead, fallback, defaults (+20)
  - `events-nats/kafka/amqp` — adapter utility functions (+15)

- [#8](https://github.com/Connectum-Framework/connectum/pull/8) [`76eb476`](https://github.com/Connectum-Framework/connectum/commit/76eb476298b2bcbbf5cfbd8de682f9dfec9a248e) Thanks [@intech](https://github.com/intech)! - Обновлены production-зависимости:

  **@connectum/otel** (minor):

  - OpenTelemetry SDK обновлён до v2 (@opentelemetry/resources ^2.5.1, @opentelemetry/sdk-trace-node ^2.5.1, @opentelemetry/sdk-metrics ^2.5.1, experimental packages ^0.212.0)
  - Resource class заменён на resourceFromAttributes()
  - LoggerProvider: processors передаются через constructor
  - MeterProvider: добавлен resource parameter

  **@connectum/core** (minor):

  - Zod обновлён с v3 до v4 (^4.3.6)
  - Изменён тип возврата safeParseEnvConfig (убрана явная аннотация z.SafeParseReturnType)

  **@connectum/cli** (patch):

  - citty обновлён до ^0.2.1
  - Исправлена типизация ProtoSyncOptions.template для exactOptionalPropertyTypes

  Также обновлены:

  - @biomejs/biome: ^1.9.4 → ^2.3.15 (конфиг автомигрирован)

- [#151](https://github.com/Connectum-Framework/connectum/pull/151) [`a839d37`](https://github.com/Connectum-Framework/connectum/commit/a839d3700e76a83e243f5a7154991c72add266b4) Thanks [@intech](https://github.com/intech)! - chore(deps): bump in-range production dependencies

  Raise the lower bounds of catalog-managed production dependencies within their
  existing `^` ranges (minor/patch, no breaking changes). On publish, pnpm rewrites
  each `catalog:` specifier to the concrete range, so raising the floor changes the
  dependency contract surfaced to consumers — hence a patch bump.

  - `@connectrpc/connect` `^2.1.1 → ^2.1.2`
  - `@connectrpc/connect-node` `^2.1.1 → ^2.1.2`
  - `@bufbuild/protobuf` `^2.11.0 → ^2.12.0`
  - `zod` `^4.3.6 → ^4.4.3`

  Affected packages (production `dependencies` referencing the above via `catalog:`):
  auth, cli, core, events, healthcheck, interceptors, otel, reflection,
  test-fixtures, testing. Build, typecheck, lint, unit/integration tests, the
  Bun/esbuild cross-runtime suites, and the HTTP ↔ in-process parity gate all pass
  with no behavioural changes (including ConnectRPC cancellation and unary-GET
  query handling paths).

  Dev-only tooling bumps in the same change (not part of the published dependency
  contract, so no version impact): `@biomejs/biome`, `@bufbuild/buf`,
  `@bufbuild/protoc-gen-es`, `@bufbuild/protovalidate`, `tsup`, `@types/node`.

- [#159](https://github.com/Connectum-Framework/connectum/pull/159) [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb) Thanks [@intech](https://github.com/intech)! - fix: preserve the `node:` protocol prefix on builtin imports

  tsup strips the `node:` prefix from builtin imports by default (`removeNodeProtocol: true`). The bare forms (`crypto`, `fs`, `http2`, …) are valid Node aliases, but the `node:` prefix is the portable specifier across runtimes — Deno resolves builtins prefix-first (bare forms are not guaranteed), and prefix-only builtins like `node:test` have no bare alias at all. Every package now sets `removeNodeProtocol: false`, so the published artifacts keep the prefix on every builtin import for maximum cross-runtime portability (Node / Bun / Deno). No runtime behavior change on Node. (`@connectum/testing` already carried this fix.)

## 1.0.0-rc.11

## 1.0.0-rc.10

## 1.0.0-rc.9

## 1.0.0-rc.8

### Patch Changes

- [#70](https://github.com/Connectum-Framework/connectum/pull/70) [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda) Thanks [@intech](https://github.com/intech)! - Comprehensive test coverage improvements across 10 packages (+225 tests).

  **New test files:**

  - `core/envSchema.test.ts` — env config validation (50 tests)
  - `core/server-lifecycle.test.ts` — server integration with eventBus, protocols, shutdown (24 tests)
  - `auth/errors.test.ts` — AuthzDeniedError (14 tests)
  - `auth/authz-utils.test.ts` — satisfiesRequirements() (12 tests)
  - `cli/proto-sync.test.ts` — CLI unit tests (33 tests, was 4 integration-only)
  - `events/topic.test.ts` — resolveTopicName() (3 tests)
  - `healthcheck/healthcheck-grpc.test.ts` — gRPC Health Check + HTTP E2E (11 tests)

  **Extended existing tests:**

  - `core` — Server state transitions, ShutdownManager deps/cycles, graceful shutdown edge cases (+17)
  - `healthcheck` — gRPC handlers, manager merge, HTTP handler scenarios (+17)
  - `reflection` — circular deps, empty registry, multiple services (+6)
  - `interceptors` — error handler, timeout, retry, bulkhead, fallback, defaults (+20)
  - `events-nats/kafka/amqp` — adapter utility functions (+15)

## 1.0.0-rc.7

## 1.0.0-rc.6

## 1.0.0-rc.5

## 1.0.0-rc.4

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

## 1.0.0-rc.3

## 1.0.0-rc.2

### Patch Changes

- [#8](https://github.com/Connectum-Framework/connectum/pull/8) [`76eb476`](https://github.com/Connectum-Framework/connectum/commit/76eb476298b2bcbbf5cfbd8de682f9dfec9a248e) Thanks [@intech](https://github.com/intech)! - Updated production dependencies:

  **@connectum/otel** (minor):

  - OpenTelemetry SDK updated to v2 (@opentelemetry/resources ^2.5.1, @opentelemetry/sdk-trace-node ^2.5.1, @opentelemetry/sdk-metrics ^2.5.1, experimental packages ^0.212.0)
  - Resource class replaced with resourceFromAttributes()
  - LoggerProvider: processors are now passed via the constructor
  - MeterProvider: added resource parameter

  **@connectum/core** (minor):

  - Zod updated from v3 to v4 (^4.3.6)
  - Changed safeParseEnvConfig return type (removed explicit z.SafeParseReturnType annotation)

  **@connectum/cli** (patch):

  - citty updated to ^0.2.1
  - Fixed ProtoSyncOptions.template typing for exactOptionalPropertyTypes

  Also updated:

  - @biomejs/biome: ^1.9.4 → ^2.3.15 (config auto-migrated)

## 1.0.0-beta.2

## 0.2.0-beta.1

### Patch Changes

- chore: clean up package dependencies
- chore: update dependencies

## 0.2.0-alpha.2

Initial alpha release.
