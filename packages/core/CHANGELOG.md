# @connectum/core

## 1.3.0

### Minor Changes

- [#480](https://github.com/Connectum-Framework/connectum/pull/480) [`69f5fda`](https://github.com/Connectum-Framework/connectum/commit/69f5fdac2cbce8927079c6494de5eac04db5e3c4) Thanks [@intech](https://github.com/intech)! - docs: leaving a `for await` loop over a streaming response with `break` now ends the call, on `server.localClient()` and over HTTP alike.
  
  With `@connectrpc/connect` 2.3.0 and later the response iterator of a server-streaming or bidirectional call has `return()` and `throw()`. A `break` (or a thrown error in the loop body) calls `return()`, which aborts the call's signal: the handler's `ctx.signal` aborts and its `finally` runs without any further abort by the caller and without `server.stop()`. Client-side interceptors see their response stream end without an error, since the caller chose to stop; only the handler sees the call as cancelled. Before, a `break` left the handler parked at its last `yield` until the call was ended some other way.
  
  `createLocalTransport()`, `Server.localClient()` and the cancellation notes in their documentation now describe this. Handlers that relied on a stream surviving the caller leaving the loop must keep the caller reading, or move the work out of the stream handler. `ctx.stream()` consumers get the same behaviour for the target call. No Connectum code path changed: the behaviour comes from the Connect client, so it applies on both transports by construction.
  
  The peer ranges of `@connectrpc/connect` and `@connectrpc/connect-node` in `@connectum/core` and `@connectum/testing` are raised from `^2.2.0` to `^2.3.0`, which `createServer()` enforces at start-up. Two further 2.3.0 behaviours are visible: a client-side response wrapper parked at `yield` is resumed when the call is aborted, and on a kept-alive HTTP/1 connection a call rejected by `requestGate` has up to 256 KiB of its unread body discarded by the transport (the handler still never parses it).

- [#339](https://github.com/Connectum-Framework/connectum/pull/339) [`e279cbd`](https://github.com/Connectum-Framework/connectum/commit/e279cbd09fe4a064a00370f62f6b78c2d947182d) Thanks [@intech](https://github.com/intech)! - fix: `outgoingInterceptors` now run on every catalog route
  
  `createServer({ outgoingInterceptors })` was documented since 1.0.0 as the client-side chain for every `ctx.call` / `ctx.stream` and `server.client()` call, but it ran only on `ctx.call` / `ctx.stream` to services mounted on the same server. It now runs exactly once per call on every route — in-process, `remoteResolver` transports and `mockResolver` routes in `createMockContext` — and on `server.client()` for local and remote targets, for unary and all streaming kinds. The resolver's transport is wrapped (Connect's `runUnaryCall` / `runStreamingCall` around it): the chain runs outside the transport's own interceptors, the deadline budget starts before the first interceptor, and the transport receives the remaining budget. With an empty chain the resolver's transport is used unchanged. `server.localClient()` and `createLocalTransport()` stay plain. On a resolver route the chain observes `req.url` as `https://catalog/<typeName>/<Method>` and no protocol headers; wire-level policy (header signing, host-derived audiences) belongs on the resolver's transport.
  
  New: `createCatalogClient({ outgoingInterceptors })` — an explicit chain for the standalone client (default empty; it never inherits one from a `Server`).
  
  **Migration (BREAKING for one configuration):** if you mounted the same signer, OpenTelemetry or retry interceptor on the resolver's transports as a workaround for remote routes, remove that copy — it would now run twice (two client spans, two token-factory calls, retry amplification). Keep application policy in `outgoingInterceptors` and only transport-specific middleware (TLS, compression, per-upstream gateway headers) on the transports. A `server.client()` call to a local service now also runs the chain; use `server.localClient()` for the plain in-process client.
  
  **Migration (credentials reach every resolver target):** before this change a signer in `outgoingInterceptors` never ran on a `remoteResolver` route; now it runs for every target the resolver returns. If one of them is in another trust domain (a partner API, a third-party service), your internal token is sent there. Restrict the signer by `req.service.typeName`, or keep that credential on the transport of the one target that needs it and out of `outgoingInterceptors`.

- [#633](https://github.com/Connectum-Framework/connectum/pull/633) [`ef74e53`](https://github.com/Connectum-Framework/connectum/commit/ef74e53284f183fe95492d23877a3f7adc27514d) Thanks [@intech](https://github.com/intech)! - fix: `CallOptions.timeoutMs` on `ctx.call`, `ctx.stream` and `createCatalogClient()` must be a finite number greater than 0. A zero or negative value used to remove the deadline the call inherits, so the callee ran without any limit; it now rejects the call with `InvalidArgument` and a message that names `timeoutMs`, as do `NaN`, `Infinity` and non-numbers. When the inbound deadline has already passed, a nested `ctx.call` or `ctx.stream` fails with `DeadlineExceeded` instead of passing a non-positive timeout on. Valid values keep their meaning: the effective timeout is still `min(timeoutMs, remaining)`.

- [#633](https://github.com/Connectum-Framework/connectum/pull/633) [`ef74e53`](https://github.com/Connectum-Framework/connectum/commit/ef74e53284f183fe95492d23877a3f7adc27514d) Thanks [@intech](https://github.com/intech)! - fix: the catalog and resolver options are checked where they are accepted, not only in `defineCatalog()`. `createServer({ catalog })` and `createCatalogClient({ catalog })` throw `CatalogConfigError` for a catalog whose key differs from its descriptor's `typeName` (same message form as `defineCatalog`), which previously let `enabledServices: ["wrong"]` match and mount nothing. `createCatalogClient()` throws when `resolver` is missing or not a function. `dnsResolver()` throws when `template` is not a non-empty string or `createTransport` is not a function, and `perServiceEnvResolver()` / `mapResolver()` throw when the map is not an object. Valid configurations behave as before.

- [#633](https://github.com/Connectum-Framework/connectum/pull/633) [`ef74e53`](https://github.com/Connectum-Framework/connectum/commit/ef74e53284f183fe95492d23877a3f7adc27514d) Thanks [@intech](https://github.com/intech)! - fix: `ctx.call` and `ctx.stream` to a catalog service that is not mounted locally, on a server with no `remoteResolver`, now fail with `FailedPrecondition` and the message `server.client()` already gives ("not mounted locally and no remoteResolver is configured"), instead of `Unavailable` with "the resolver returned null". That is a wiring mistake, and `Unavailable` is the code the `retry` interceptor retries by default, so it was retried as if the service were down. **Behaviour change:** code that matched `Unavailable` for this case (a server without `remoteResolver`) now sees `FailedPrecondition`. A configured `remoteResolver` that returns `null` still gives `Unavailable`.

- [#633](https://github.com/Connectum-Framework/connectum/pull/633) [`ef74e53`](https://github.com/Connectum-Framework/connectum/commit/ef74e53284f183fe95492d23877a3f7adc27514d) Thanks [@intech](https://github.com/intech)! - fix: mistakes in service definitions now fail where they are made, with the service named. `defineService` throws a `TypeError` when the handlers are not an object or a member is not a function; `defineLazyService` applies the same check to the factory result when the factory runs, so `start()` no longer fails with "Cannot convert undefined or null to object" and an `async` factory (which used to mount a service whose every method was `unimplemented`) is rejected with a message that says the factory must be synchronous. Defining the same service twice is rejected by `createServer()` and `addService()` with `CatalogConfigError` naming the type name; before, the last definition silently won. A method that is left out is still allowed and answers `unimplemented`.

- [#470](https://github.com/Connectum-Framework/connectum/pull/470) [`4b2672c`](https://github.com/Connectum-Framework/connectum/commit/4b2672cbee5d98d4624fb04344b795c44e50824c) Thanks [@intech](https://github.com/intech)! - feat: `enabledServicesFromEnv(value)` configures `enabledServices` from an environment variable in one line: `createServer({ services, enabledServices: enabledServicesFromEnv(process.env.CONNECTUM_SERVICES) })`. A variable that is unset, empty, whitespace or only commas gives `undefined`, so the server mounts every supplied service as it does when the option is omitted; a comma-separated value gives the named `typeName`s, trimmed. To mount none of the supplied services, pass `enabledServices: []` directly.
  
  Why: `parseServicesEnv(undefined)` returns `[]`, and `[]` mounts none of the supplied services, so `enabledServices: parseServicesEnv(process.env.CONNECTUM_SERVICES)` started a process with no business services whenever the variable was unset, and every caller had to add a ternary around it. `parseServicesEnv` is unchanged (it is released API, and `[]` there is what its consumers read), and its documentation now says so. `CreateServerOptions.enabledServices` also accepts an explicit `undefined`, which a project with `exactOptionalPropertyTypes` needs to pass the helper's result as it is; passing a list or omitting the option behaves as before.

- [#633](https://github.com/Connectum-Framework/connectum/pull/633) [`ef74e53`](https://github.com/Connectum-Framework/connectum/commit/ef74e53284f183fe95492d23877a3f7adc27514d) Thanks [@intech](https://github.com/intech)! - fix: `start()` now checks every `enabledServices` entry against the services passed to `createServer()` (and added with `addService()`), also when no `catalog` is configured. Before, a misspelled type name (for example from an environment variable) started a server that mounted nothing and answered every call with `unimplemented`; now `start()` rejects with `CatalogConfigError` naming the unknown entries and the type names available. A list that names only supplied services, and an empty list, behave as before. An entry that names a catalog service which is not in `services` is rejected as well, because it mounts nothing either.

- [#632](https://github.com/Connectum-Framework/connectum/pull/632) [`6fbc917`](https://github.com/Connectum-Framework/connectum/commit/6fbc9178534aa82cd39b9a3594b5db2e1ede09c2) Thanks [@intech](https://github.com/intech)! - fix: the environment schema is stricter about two variables. `PORT` must be written in decimal digits: `0x50`, `1e3`, `+80` and values with surrounding spaces, which `Number()` read as ports, are rejected with an issue on `PORT`. `OTEL_EXPORTER_OTLP_ENDPOINT` must be an `http:` or `https:` URL: `localhost:4318` and `ftp://x` are rejected with an issue on that variable instead of failing later in the exporter. Documented values are unaffected.
  
  An empty `OTEL_SERVICE_NAME` or `OTEL_EXPORTER_OTLP_ENDPOINT` is now read as unset, as the OpenTelemetry SDK reads an empty value of its variables (the empty endpoint used to be rejected as an invalid URL). A `PORT` written with leading zeros such as `08080` is still accepted and read as decimal 8080.

- [#632](https://github.com/Connectum-Framework/connectum/pull/632) [`6fbc917`](https://github.com/Connectum-Framework/connectum/commit/6fbc9178534aa82cd39b9a3594b5db2e1ede09c2) Thanks [@intech](https://github.com/intech)! - fix: `createServer()` now validates `port` and `host` at creation. A `port` that is not an integer from 0 to 65535 (a string such as `"abc"`, which Node treated as a Unix socket path, included) throws a `TypeError` or `RangeError` naming `port`; an empty or non-string `host`, which used to bind every interface, throws an error naming `host`. Valid values behave as before. Code that passed a numeric string as `port` must pass a number.

- [#633](https://github.com/Connectum-Framework/connectum/pull/633) [`ef74e53`](https://github.com/Connectum-Framework/connectum/commit/ef74e53284f183fe95492d23877a3f7adc27514d) Thanks [@intech](https://github.com/intech)! - fix: `createServer({ propagateHeaders })` now checks its entries when the server is created. A name that is not a valid HTTP header name (`"x y"`, `""`, a pseudo-header such as `":authority"`) or a value that is not an array of strings throws a `TypeError` that names `propagateHeaders` and the entry. Before, the server started and every `ctx.call` threw `TypeError: Headers.get: ... is an invalid header name`, which reached the caller as `internal`. Valid lists, including `defaultPropagateHeaders` with your own names added, behave as before.

- [#658](https://github.com/Connectum-Framework/connectum/pull/658) [`f15f8f4`](https://github.com/Connectum-Framework/connectum/commit/f15f8f4131349a6134d36272fd4ea346f147bb9b) Thanks [@intech](https://github.com/intech)! - fix: `server.stop()` no longer ends a server stream that is still sending with a successful end of stream. The response iterator the framework finishes on abort used to complete normally, so a Connect client got an end-stream frame without an error and a gRPC client got `grpc-status: 0`, with a truncated list of messages that looked complete. The client now receives the messages already sent and then an `unavailable` error (`the server is shutting down`) for a server stop, the abort reason's own error for a deadline, and `canceled` for a client abort. This holds over HTTP (Connect and gRPC protocols) and for in-process calls. A handler that returns by itself after it sees `ctx.signal` abort still ends the call normally, and a handler that rethrows the abort reason is still reported as `canceled`. A client that retried only on errors now sees `unavailable` where it used to see success.

- [#655](https://github.com/Connectum-Framework/connectum/pull/655) [`94cc0cc`](https://github.com/Connectum-Framework/connectum/commit/94cc0ccceb1b3c8690f79414e130a361a7bc47ea) Thanks [@intech](https://github.com/intech)! - fix: when a shutdown hook fails, `server.stop()` now runs every other hook and waits for all of them before it emits `stop` and rejects. Before, `stop()` rejected and emitted `stop` as soon as the first hook failed, leaving independent hooks that were still running unawaited (a process that exits on the rejected `stop()` cut them off) and never running the hooks that depended on the failed one. A hook that depends on a failed hook now runs after it has finished, because it releases a resource of its own. `stop()` rejects with the single failure itself, or with an `AggregateError` of all failures in registration order when several hooks failed.

- [#655](https://github.com/Connectum-Framework/connectum/pull/655) [`94cc0cc`](https://github.com/Connectum-Framework/connectum/commit/94cc0ccceb1b3c8690f79414e130a361a7bc47ea) Thanks [@intech](https://github.com/intech)! - fix: `server.onShutdown()` now rejects arguments that match none of its three forms with a `TypeError` that starts with `onShutdown(` and names the problem, where it used to fail with `TypeError: dependencies is not iterable` (the text differs on Bun). A call without a hook function, a non-string module name, dependencies that are not an array of strings, and a string where the array of dependencies belongs all throw at registration. The last one used to be spread into one dependency per character, so `onShutdown('x', 'db', fn)` ran `x` without waiting for `db`. Calls that match the documented forms behave as before, and a dependency on a name nobody registered is still accepted.

- [#632](https://github.com/Connectum-Framework/connectum/pull/632) [`6fbc917`](https://github.com/Connectum-Framework/connectum/commit/6fbc9178534aa82cd39b9a3594b5db2e1ede09c2) Thanks [@intech](https://github.com/intech)! - fix: `createServer()` now validates `shutdown.signals` and `shutdown.autoShutdown` at creation. `autoShutdown` must be a boolean; `signals` must be a non-empty array of signal names the platform knows (not `SIGKILL` or `SIGSTOP`, which a process cannot handle). Before, an unknown name, an empty list or a string left no handler installed, so SIGTERM ended the process without running the shutdown hooks. The error names the option, and for an unknown signal the signal. Valid values behave as before.

- [#655](https://github.com/Connectum-Framework/connectum/pull/655) [`94cc0cc`](https://github.com/Connectum-Framework/connectum/commit/94cc0ccceb1b3c8690f79414e130a361a7bc47ea) Thanks [@intech](https://github.com/intech)! - fix: a termination request that arrives while `start()` is still in progress is no longer dropped. `server.stop()` called while the server is starting used to reject with `Cannot stop server: current state is "starting"`, and the server then finished starting and ran until it was killed. Now `stop()` waits for the start to settle and stops the server (the event bus and the shutdown hooks run as usual); if the start fails, `stop()` resolves because the server is already stopped. With `shutdown.autoShutdown`, the signal handlers are installed when `start()` begins instead of after the port is bound, so a `SIGTERM` during a slow startup (an event bus connecting to a broker) triggers a graceful shutdown after the start instead of ending the process abruptly with exit code 143 and no hooks. `stop()` on a server that was never started still rejects. A `start()` that never settles also keeps a pending stop waiting.

- [#655](https://github.com/Connectum-Framework/connectum/pull/655) [`94cc0cc`](https://github.com/Connectum-Framework/connectum/commit/94cc0ccceb1b3c8690f79414e130a361a7bc47ea) Thanks [@intech](https://github.com/intech)! - fix: an empty or whitespace-only `GRACEFUL_SHUTDOWN_TIMEOUT_MS` is now rejected by `parseEnvConfig()` and `safeParseEnvConfig()` with an issue on `GRACEFUL_SHUTDOWN_TIMEOUT_MS`, the way an empty `PORT` already is. It used to parse to `0`, so `GRACEFUL_SHUTDOWN_TIMEOUT_MS=` in a compose file or a manifest switched connection draining off and `stop()` cut in-flight requests at once. Leave the variable out (or `undefined`) to get the default of 30000.

- [#655](https://github.com/Connectum-Framework/connectum/pull/655) [`94cc0cc`](https://github.com/Connectum-Framework/connectum/commit/94cc0ccceb1b3c8690f79414e130a361a7bc47ea) Thanks [@intech](https://github.com/intech)! - fix: `GRACEFUL_SHUTDOWN_TIMEOUT_MS` must be a whole number of milliseconds. `parseEnvConfig()` and `safeParseEnvConfig()` now reject a fractional value such as `1.5` with an issue on `GRACEFUL_SHUTDOWN_TIMEOUT_MS`, where it used to pass and then make `createServer({ shutdown: { timeout } })` throw a `RangeError` that did not name the variable. Whole values from 0 to 300000 are accepted as before.

- [#281](https://github.com/Connectum-Framework/connectum/pull/281) [`0162e26`](https://github.com/Connectum-Framework/connectum/commit/0162e268a58f0262910bd000e8ff4ff2dc4d34c6) Thanks [@intech](https://github.com/intech)! - fix(core)!: `server.stop()` aborts in-process calls like HTTP calls
  
  **BREAKING (behaviour):** in-flight in-process calls — `server.localClient()`, `server.client()` for a local service, `createLocalTransport()`, and `ctx.call` / `ctx.stream` to a local service — now have their `context.signal` aborted when `server.stop()` begins, exactly like calls received over HTTP. Previously the in-process router never received the server's shutdown signal, so local handlers, streams and pending request gates kept running unaware of the shutdown.
  
  - A handler, stream or `requestGate` that watches `context.signal` now ends on `stop()` on both transports. A handler that rethrows the abort ends the call with `Code.Canceled`, the same as over HTTP.
  - A handler that ignores the signal is not killed. `stop()` does not wait for in-process calls either: they ride no connection, so there is nothing for the timeout race or `forceCloseOnTimeout` to drain or destroy.
  - In a `ctx.call` chain, every local hop is aborted directly, not only through the outer call.
  - A local call made after `stop()` starts with an already-aborted signal. Before `start()`, the signal is live, as before.
  - **Action:** if code relied on local calls finishing undisturbed during shutdown, handle `context.signal` explicitly. For example, finish the work before calling `stop()`, or run it in a shutdown hook.

- [#282](https://github.com/Connectum-Framework/connectum/pull/282) [`36ce828`](https://github.com/Connectum-Framework/connectum/commit/36ce828cd36d84285e657b843b65ddbf28111107) Thanks [@intech](https://github.com/intech)! - feat: declare protobuf and Connect as peer dependencies, so an application runs with one copy of each
  
  `@bufbuild/protobuf`, `@connectrpc/connect` and `@connectrpc/connect-node` were regular dependencies. An application that pinned its own version could end up with a second copy that nothing reported: message and service types generated against one copy then stopped type-checking against the other, and a `connect-node` next to a different `connect` formed a pair `connect-node` does not support (it requires one exact `connect` version).
  
  - `@connectum/core`, `auth`, `events`, `healthcheck`, `interceptors`, `otel`, `reflection`, `testing` and `test-fixtures` now declare `@bufbuild/protobuf` `^2.16.0` and `@connectrpc/connect` `^2.2.0` in `peerDependencies`; `core` and `testing` also declare `@connectrpc/connect-node` `^2.2.0`.
  - `auth`, `events` and `interceptors` declare `@connectum/core` as a peer dependency instead of a dependency, so they use the application's own `@connectum/core`.
  - `@connectum/interceptors` now depends on `@bufbuild/protovalidate` directly. The validation interceptor imports it whether or not validation is enabled; it used to install only because npm, pnpm and Bun add missing peers of `@connectrpc/validate`.
  - `@connectum/cli` and `@connectum/protoc-gen-catalog` are unchanged: they are executables, and `@bufbuild/protoplugin` pins `@bufbuild/protobuf` exactly, so they keep their own copy and are outside the single-copy guarantee.
  
  With pins inside these ranges, or no pins at all, npm, pnpm and Bun now install exactly one copy of each library for the application and every Connectum runtime package. This includes `@connectum/reflection`, which now serves gRPC Server Reflection with Connectum's own implementation instead of a third-party library that kept its own protobuf / Connect copy.
  
  `createServer()` now checks the `@bufbuild/protobuf`, `@connectrpc/connect` and `@connectrpc/connect-node` that `@connectum/core` actually loaded against these ranges, and throws `PeerDependencyVersionError` (exported from `@connectum/core`) naming the package, the loaded version and its location, the required range and the fix. Lockstep is checked at startup too: the `@connectrpc/connect` that `@connectrpc/connect-node` itself loads must be the exact version connect-node declares, and the same copy `@connectum/core` loads. This makes an out-of-range version a visible startup failure on every package manager, including the ones that only warn at install time. When the version cannot be determined — `@connectum/core` bundled into the application, or a runtime without `import.meta.resolve` — the check is skipped rather than guessed.
  
  **BREAKING (installation and startup):** an install or a start that worked before can now fail.
  
  - npm refuses an application whose `@bufbuild/protobuf`, `@connectrpc/connect` or `@connectrpc/connect-node` pin is outside the ranges above, with `ERESOLVE unable to resolve dependency tree`. pnpm prints `Issues with peer dependencies found` (`pnpm peers check` names the library) and keeps the application's too-old copy; Bun warns in the same way, but stays silent about a too-old `@bufbuild/protobuf` when a code generator such as `protoc-gen-es` brings its own in-range copy. On pnpm and Bun the application then stops at `createServer()` with `PeerDependencyVersionError`.
  
  Under strict Semantic Versioning this is a major change, and Connectum's breaking-changes strategy does not plan breaking changes for minor versions. It ships in 1.3.0 as an explicit, recorded exception, so that applications get the single-copy fix now rather than with 2.0.
  
  Migration: raise any pin of `@bufbuild/protobuf` to `^2.16.0` and of `@connectrpc/connect` / `@connectrpc/connect-node` to `^2.2.0`, keeping `connect` and `connect-node` on the same version — or remove the pins and let npm, pnpm or Bun install the peers. Do not work around a conflict with `--legacy-peer-deps` or `--force`: that reinstates the duplicate copies. Generate code with `protoc-gen-es` 2.16 or later.

- [#283](https://github.com/Connectum-Framework/connectum/pull/283) [`0cc15bb`](https://github.com/Connectum-Framework/connectum/commit/0cc15bb38fe23d8e9ac1a4b669b97c0b496d5e76) Thanks [@intech](https://github.com/intech)! - `ProtocolContext` gains `services`: the services mounted before the protocol, in registration order, as a frozen snapshot next to `registry`.
  
  `registry` holds the files of the mounted services, and a file may declare more services than are mounted (several services in one proto file, or `enabledServices` mounting a subset). Everything that reasons about served services now uses the mounted ones:
  
  - `@connectum/healthcheck` tracks only mounted services: an unmounted service declared in the same file as a mounted one no longer appears in `List`, and `Check` for it answers `NOT_FOUND`.
  - `@connectum/reflection` lists only mounted services in `list_services`.
  - `server.start()` transport validation checks only mounted application services. Before, a mounted unary service whose file also declared an unmounted bidi service failed startup on plaintext HTTP/1.1 with `CONNECTUM_UNSUPPORTED_STREAMING_TRANSPORT` for a method nobody could call. `collectStreamingMethods` now also accepts `DescService`s; passing files keeps the previous meaning (every service the files declare).
  
  Custom protocols that derived service names from `context.registry[].services` should switch to `context.services`. Code that builds a `ProtocolContext` by hand (tests calling `setup` directly) must now pass `services` as well.

- [#265](https://github.com/Connectum-Framework/connectum/pull/265) [`bc770be`](https://github.com/Connectum-Framework/connectum/commit/bc770bee1669e91804f6115b5dfe2e254f129760) Thanks [@intech](https://github.com/intech)! - fix: health, reflection and lazy services stay consistent across the HTTP and in-process transports
  
  A server builds one router for the HTTP adapter and one per in-process transport (`server.localClient()`, the catalog transport behind `ctx.call`). Every extra router re-ran one-time work:
  
  - **Healthcheck** — the first in-process call re-initialized the health manager: application services were dropped and `grpc.health.v1.Health` itself was tracked as `UNKNOWN`, so overall health fell from `SERVING` to `NOT_SERVING` and readiness probes started failing after the first `ctx.call` / `localClient()`. Overall health and the tracked service set are now unaffected by in-process transports.
  - **Reflection** — the in-process listing was rebuilt from the grown registry and additionally advertised `grpc.reflection.v1.ServerReflection` / `grpc.reflection.v1alpha.ServerReflection`, diverging from the HTTP listing. Both transports now serve the same descriptor set.
  - **`defineLazyService`** — `factory` ran once per router, so HTTP and in-process callers reached different implementation instances and resources opened by the factory were duplicated. `factory` now runs once per server; the same definition mounted on two servers still yields one instance per server.
  
  **BREAKING (custom protocol authors only):** `ProtocolRegistration` separates one-time initialization from route registration. The new optional `setup(context)` runs exactly once per server, immediately before the protocol's first `register`, with a frozen snapshot of the registry (application services plus the services of protocols listed earlier). `register(router)` no longer receives `context`, runs once per router, and must only add routes. Move everything that reads `context` or has side effects from `register` into `setup`. A two-argument `register` no longer type-checks. Applications that only use the built-in `Healthcheck()` / `Reflection()` need no changes.

- [#326](https://github.com/Connectum-Framework/connectum/pull/326) [`5f0038d`](https://github.com/Connectum-Framework/connectum/commit/5f0038d267cf6b1b6d058e9b7cc8dd275a18080e) Thanks [@intech](https://github.com/intech)! - feat: a call to a procedure or service the server does not serve is answered with `unimplemented` encoded in the protocol of the request
  
  Until now every request that matched no route and no protocol HTTP handler received a bare `404 Not Found` with a text body. A client that follows the protocols reads a 404 as `unimplemented` on its own, but it got no error object, no end-of-stream envelope and no `grpc-status`. The server now answers an RPC call in the request's own encoding:
  
  - Connect unary: HTTP 501 with a JSON body `{"code":"unimplemented","message":"procedure not found: /<service>/<method>"}`.
  - Connect streaming: HTTP 200 with a single end-of-stream envelope carrying the error.
  - gRPC: `grpc-status: 12` with a percent-encoded `grpc-message` (Trailers-Only, no body).
  - gRPC-Web: a single trailers frame carrying `grpc-status: 12` and `grpc-message`.
  
  The message names the requested path, cut to 200 characters; on gRPC and gRPC-Web every byte outside `0x20–0x7E` and every `%` is percent-encoded, so no byte of the path can alter the response. Requests that are not served RPC calls — `GET`, a path that is not `/<service>/<method>`, `application/grpc-web-text`, any other content type — keep the plain `404 Not Found`, and protocol HTTP handlers (health, custom) still answer first. The encoding is written out from the protocol text rather than taken from `@connectrpc/connect`'s `@private` encoders, which carry no semver guarantee.
  
  Behavior change: code that matched the old bare `404` for an unknown RPC procedure now sees HTTP 501 on Connect unary and HTTP 200 with a protocol status on gRPC, gRPC-Web and Connect streaming.

- [#281](https://github.com/Connectum-Framework/connectum/pull/281) [`0162e26`](https://github.com/Connectum-Framework/connectum/commit/0162e268a58f0262910bd000e8ff4ff2dc4d34c6) Thanks [@intech](https://github.com/intech)! - feat(core): server-level `requestGate` and `readMaxBytes` in `createServer()`
  
  - **`requestGate`** is Connect's gate, set as a server-wide default. It receives the call's `HandlerContext` after the headers arrive and before any request message is received, decompressed or parsed. Throw a `ConnectError` to reject the call without reading the body.
  - **`readMaxBytes`** is a server-wide per-message read limit. A larger message ends with `ResourceExhausted` before the handler runs.
  - **Both are opt-in and unset by default.** Servers that do not set them behave exactly as before.
  - **Identical on both transports.** Both options apply the same way over HTTP and in-process: `server.localClient()`, `createLocalTransport()`, and `ctx.call` / `ctx.stream` to a local service.
    - There is no in-process exemption. An internal `ctx.call` carries only the headers you forward with `propagateHeaders` or `outgoingInterceptors`.
  - **Service values override.** A service's own `requestGate` or `readMaxBytes` in `ServiceOptions` replaces the server default for that service. They are not composed, and the server value is not a ceiling.
  - **Gate errors bypass `errorHandler`.** A gate runs before the server interceptors. A thrown `ConnectError` reaches the client as thrown, so give it a client-safe message. Anything else is replaced by Connect with `internal error` (`Code.Internal`); its text never reaches the client.
  - **Invalid values fail fast.** `createServer()` throws a `RangeError` naming the option when `readMaxBytes` is not an integer from 1 to 4294967295 (`0`, negatives, fractions, `NaN`, `Infinity`), and a `TypeError` for a non-number `readMaxBytes` or a non-function `requestGate`. Left to Connect, `NaN` would silently disable the limit.
  - **No server-side telemetry for rejections.** A rejected call produces no server span, metric or log entry. Wrap the gate yourself to audit rejections.
  - **What the gate covers.** Every RPC on the router is gated, including gRPC Health and Reflection. HTTP endpoints served by protocol HTTP handlers, such as `/healthz`, are not.
  - **Cancellation is cooperative.** `context.signal` aborts on the call's deadline, on client cancellation, and when `server.stop()` begins, on both transports.
  - **Security fix.** HTTP requests now have a forged `connectum-internal-transport` header deleted before Connect builds the request. Previously it was removed only by an interceptor, which runs after a gate. Any gate, server-level or per-service, could therefore observe a forged in-process marker.
  - **`@connectum/testing`:**
    - `transportParityTest()` accepts `requestGate` and `readMaxBytes` and applies them to both servers.
    - `defaultCompare` treats one documented difference as equal: a `readMaxBytes` diagnostic text that includes the observed size on one transport and omits it on the other, for the same configured limit.

### Patch Changes

- [#335](https://github.com/Connectum-Framework/connectum/pull/335) [`f9f5b94`](https://github.com/Connectum-Framework/connectum/commit/f9f5b94d5a75b334ae71d7ab48d05801c2040afb) Thanks [@intech](https://github.com/intech)! - fix: the verified identity now stays available to server-streaming and bidirectional handlers for the whole call.
  
  `getAuthContext()` and `requireAuthContext()` used to return `undefined` in a generator handler as soon as it suspended (after the first `await` or `yield`, and in `finally`), and over `server.localClient()` the handler could instead see the identity held by the caller of the local client. The authentication interceptors (`createAuthInterceptor`, `createJwtAuthInterceptor`, `createSessionAuthInterceptor`, `createGatewayAuthInterceptor`, `createInternalAuthInterceptor`, cached or not) now scope the identity to the creation of the response stream and to each of its `next`, `return` and `throw` operations, so every part of the handler runs under the identity verified for its own call. Unary and client-streaming calls, rejected credentials, response headers and trailers, message order and the early-end semantics are unchanged.
  
  Code that worked around this (capturing the identity before the first `await`, reading the propagated headers, or re-entering `authContextStorage.run` around the iterator) keeps working and can be removed.
  
  `@connectum/core` binds the cleanup it triggers when a streaming call is cancelled (client abort, deadline, server shutdown) to the context in which the call's stream was created, so the handler's `finally` runs under the call's own `AsyncLocalStorage` values instead of those of whatever raised the abort. No public API changes.

- [#475](https://github.com/Connectum-Framework/connectum/pull/475) [`3b8d3e0`](https://github.com/Connectum-Framework/connectum/commit/3b8d3e06ebd729ec53e5bcad396743be73d7ef0a) Thanks [@intech](https://github.com/intech)! - docs: the `CallOptions.headers` JSDoc no longer claims that no inbound header is propagated. By default none is, but the inbound headers listed in `createServer({ propagateHeaders })` are copied onto an outgoing `ctx.call` / `ctx.stream`, and the explicit `headers` are sent on top of them and win on a name conflict. Trace context is injected by the `@connectum/otel` client interceptor when it is mounted in `outgoingInterceptors`. No behaviour change.

- [#333](https://github.com/Connectum-Framework/connectum/pull/333) [`1a3b49b`](https://github.com/Connectum-Framework/connectum/commit/1a3b49b51cd99deba325db946e2b241d51cf9c1d) Thanks [@intech](https://github.com/intech)! - fix: a catalog client-streaming `close()` now waits for the call's final status
  
  `ClientStreamHandle.close()` of `ctx.stream` and `createCatalogClient().stream` used to resolve at the first response message and never read the rest of the response stream. A failure that followed the response was swallowed, a surplus response was ignored, and an OpenTelemetry client span (`createOtelClientInterceptor`) was started but never ended, because that interceptor ends a streaming call's span only when the response stream ends.
  
  `close()` now reads the response stream to its end, as a standard `@connectrpc/connect` client-streaming call does: it resolves with the response when exactly one arrived and the call succeeded, and rejects when there was no response (`Internal`, unchanged), more than one response (`Internal`), or a failure after the response (the failure itself). The client span now starts, ends and exports once (unset status on success, ERROR on failure or cancellation).
  
  Observable change: `close()` no longer settles when the response arrives but when the call finishes. A server that delays its final status holds `close()` until that status arrives, the caller aborts the signal, or the deadline passes. Code that relied on a late failure being swallowed will now see it. No API, option or type changes.

- [#633](https://github.com/Connectum-Framework/connectum/pull/633) [`ef74e53`](https://github.com/Connectum-Framework/connectum/commit/ef74e53284f183fe95492d23877a3f7adc27514d) Thanks [@intech](https://github.com/intech)! - fix: an empty `endpoint` in `CallOptions` or `server.client()` options is now treated as no endpoint everywhere. The transport cache already gave `""` and an absent endpoint one entry, but the `remoteResolver` received `{ typeName, endpoint: "" }` or `{ typeName }` depending on which call came first, and every later call reused whatever transport that first call produced. The resolver now always receives `{ typeName }` for both, in `ctx.call`, `ctx.stream`, `server.client()` and `createCatalogClient()`, and the no-route message no longer prints an empty endpoint.

- [#649](https://github.com/Connectum-Framework/connectum/pull/649) [`e30e2d2`](https://github.com/Connectum-Framework/connectum/commit/e30e2d2959879da7b2c6e8244eca27ae8408869d) Thanks [@intech](https://github.com/intech)! - fix: the error classes `@connectum/core` exports now keep their public names in the published build. `CatalogConfigError.name` and `PeerDependencyVersionError.name` were `"_CatalogConfigError"` and `"_PeerDependencyVersionError"`, so `constructor.name`, the first line of an uncaught-error trace on Node and the output of `console.log(error)` showed the underscore. The cause was a `setPrototypeOf` call that named the class inside its own body, which made the bundler give the class an inner name. The `name` field of an instance was never affected. The release gate now compares `Class.name` of every exported error class of every package with its export name.

- [#633](https://github.com/Connectum-Framework/connectum/pull/633) [`ef74e53`](https://github.com/Connectum-Framework/connectum/commit/ef74e53284f183fe95492d23877a3f7adc27514d) Thanks [@intech](https://github.com/intech)! - fix: `server.hasService()` no longer builds the routes for a service the application defines. Before, the first call ran every `defineLazyService` factory and made `addService()`, `addInterceptor()` and `addProtocol()` throw. Now a service from `services` / `addService()` (filtered by `enabledServices`) is answered from its definition. Only a descriptor that no definition covers, while protocols are registered, still builds the routes, because what a protocol mounts is known only then; the "routes have already been materialized" errors now name `hasService()` among the causes.

- [#314](https://github.com/Connectum-Framework/connectum/pull/314) [`0305b23`](https://github.com/Connectum-Framework/connectum/commit/0305b237899dd1b2e12adbb5adaee88835e65e9b) Thanks [@intech](https://github.com/intech)! - fix: a throwing lifecycle listener no longer leaves the server half-started or stuck.
  
  - A `start` or `ready` listener that throws is a startup failure: `start()` rejects with that exception, the bound port, the `autoShutdown` signal handlers and the event bus are released, and the server ends up `stopped` (it used to keep the port and the handlers, or stay in `starting`).
  - A `stopping` or `stop` listener that throws is isolated: the remaining listeners still run, the shutdown always reaches `stopped`, and the exception is reported through `error` (printed with `console.error` when nothing listens). It used to leave the server in `stopping` forever.
  - A failed shutdown now ends with `stop` after `error` (`stopping → error → stop`, as the lifecycle guide documents) and `stop()` still rejects with the original error.
  - A failed signal-initiated shutdown is reported once and can no longer surface as an unhandled rejection.

- [#407](https://github.com/Connectum-Framework/connectum/pull/407) [`7d9e22f`](https://github.com/Connectum-Framework/connectum/commit/7d9e22fd682bf144214baa3fe0e0adf2560599be) Thanks [@intech](https://github.com/intech)! - fix: `mapResolver` is an exact allow-list. A `typeName` the map does not own, including the names of `Object.prototype` members (`constructor`, `toString`, `hasOwnProperty`, `valueOf`, `__proto__`), now resolves to `null` (the call fails with `Code.Unavailable`) instead of returning a member inherited from `Object.prototype`. A key the map owns still resolves, whatever its name.

- [#649](https://github.com/Connectum-Framework/connectum/pull/649) [`e30e2d2`](https://github.com/Connectum-Framework/connectum/commit/e30e2d2959879da7b2c6e8244eca27ae8408869d) Thanks [@intech](https://github.com/intech)! - docs: the type documentation of `NodeResponse` now says which members a protocol `httpHandler` can call on the HTTP/1.1 or HTTP/2 response (`statusCode`, `setHeader`, `end`) and why `res.writeHead(200, headers)` and `res.write(chunk)` do not compile on the union (TS2349). The type is unchanged. The raw-HTTP examples in the protocol guide used `writeHead` and failed `tsc --strict`; they now set `statusCode` and the headers, and the same handler is covered by an integration test over HTTP/1.1 and HTTP/2 and by the release gate's consumer type-check.

- [#319](https://github.com/Connectum-Framework/connectum/pull/319) [`43394b3`](https://github.com/Connectum-Framework/connectum/commit/43394b382f3d8837b9921b74fad904b618119453) Thanks [@intech](https://github.com/intech)! - fix: invalid `shutdown.timeout`, `shutdown.forceCloseOnTimeout` and a service's own `readMaxBytes` are rejected at creation instead of silently misbehaving.
  
  - `createServer()` throws a `RangeError` for a `shutdown.timeout` that is not an integer from 0 to 2147483647 (`NaN`, `-1`, `Infinity`, a fraction, a larger value) and a `TypeError` for a non-number; a non-boolean `shutdown.forceCloseOnTimeout` throws a `TypeError`. Such timeouts used to fire after about a millisecond and cut live connections at once. `timeout: 0` stays valid.
  - `defineService()` and `defineLazyService()` validate `readMaxBytes` in the service options exactly like the server-level option (integer from 1 to 4294967295; `RangeError` / `TypeError` naming the option). `readMaxBytes: NaN` used to disable the limit silently.

- [#649](https://github.com/Connectum-Framework/connectum/pull/649) [`e30e2d2`](https://github.com/Connectum-Framework/connectum/commit/e30e2d2959879da7b2c6e8244eca27ae8408869d) Thanks [@intech](https://github.com/intech)! - fix: the `Fix:` line of `PeerDependencyVersionError` now names the file and field each package manager reads to force one in-range version: `overrides` in `package.json` for npm and Bun, `resolutions` in `package.json` for Yarn, and `overrides` in `pnpm-workspace.yaml` for pnpm 11 and later. The old text said only `pnpm "overrides"`, and a pnpm user who put it in the `pnpm` field of `package.json` got a warning that pnpm ignores the field, with the old protobuf copy still installed.

- [#633](https://github.com/Connectum-Framework/connectum/pull/633) [`ef74e53`](https://github.com/Connectum-Framework/connectum/commit/ef74e53284f183fe95492d23877a3f7adc27514d) Thanks [@intech](https://github.com/intech)! - fix: `createServer({ propagateHeaders })` copies the list when the server is created, and `defaultPropagateHeaders` is frozen. Before, pushing `"authorization"` into the array you had passed (or into `defaultPropagateHeaders`) after `createServer()` started forwarding credentials to downstream calls. Spreading `defaultPropagateHeaders` into your own list works as before.

- [#633](https://github.com/Connectum-Framework/connectum/pull/633) [`ef74e53`](https://github.com/Connectum-Framework/connectum/commit/ef74e53284f183fe95492d23877a3f7adc27514d) Thanks [@intech](https://github.com/intech)! - fix: a `remoteResolver` that returns something other than a `Transport` or `null` (a string, `undefined`, a `Promise` from an `async` resolver, an object without `unary` and `stream`) now fails the call with `Internal` and a message that names the service and says what was returned, instead of `transport.unary is not a function`. The value is no longer kept in the transport cache, so the resolver is asked again on the next call. The rejection of an abandoned `Promise` no longer surfaces as an unhandled rejection. This applies to `ctx.call`, `ctx.stream`, `server.client()` and `createCatalogClient()`. A resolver that returns `null` still gives `Unavailable`.

- [#655](https://github.com/Connectum-Framework/connectum/pull/655) [`94cc0cc`](https://github.com/Connectum-Framework/connectum/commit/94cc0ccceb1b3c8690f79414e130a361a7bc47ea) Thanks [@intech](https://github.com/intech)! - fix: a `start()` that never settles no longer makes a process with `shutdown.autoShutdown` unkillable by signals. The first `SIGTERM` or `SIGINT` during the start is recorded as a request to stop once the start settles and the framework releases its signal handlers, so a repeated signal gets the default action and ends the process, as a repeated signal does while a running server is stopping.

- [#655](https://github.com/Connectum-Framework/connectum/pull/655) [`94cc0cc`](https://github.com/Connectum-Framework/connectum/commit/94cc0ccceb1b3c8690f79414e130a361a7bc47ea) Thanks [@intech](https://github.com/intech)! - fix: servers with `shutdown.autoShutdown` now share one process listener per signal instead of adding one per server, so starting eleven or more of them in one process (a test suite, a process hosting several servers) no longer makes Node.js print `MaxListenersExceededWarning` for `SIGTERM` and `SIGINT`. Each server still stops on the signal, and the shared listener is removed when the last server stops. A signal name repeated in `shutdown.signals` no longer leaks a listener.

- [#632](https://github.com/Connectum-Framework/connectum/pull/632) [`6fbc917`](https://github.com/Connectum-Framework/connectum/commit/6fbc9178534aa82cd39b9a3594b5db2e1ede09c2) Thanks [@intech](https://github.com/intech)! - fix: a TLS key or certificate that cannot be read, or that the server refuses, now fails with an error that names the file and where its path came from (`tls.keyPath`, `tls.certPath`, `tls.dirPath`, `TLS_DIR_PATH` or the default directory), instead of OpenSSL's bare text. A key that does not match the certificate names both files. The files are handed to the server as before, so every configuration it accepted still starts; the key and certificate are parsed on their own only after the server has refused them. The error the server threw is kept as `cause` (for a read failure, the file system error, with its `code` and `path` kept on the new error).

- [#243](https://github.com/Connectum-Framework/connectum/pull/243) [`10a3e58`](https://github.com/Connectum-Framework/connectum/commit/10a3e584a1f8c6c80d96c533d88dc02300805289) Thanks [@intech](https://github.com/intech)! - Clear the remaining dependency advisories, and keep one `@bufbuild/protobuf` in the
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

- [#417](https://github.com/Connectum-Framework/connectum/pull/417) [`93b125f`](https://github.com/Connectum-Framework/connectum/commit/93b125fe672a49219ce20491fdfde41cf09f4f32) Thanks [@intech](https://github.com/intech)! - fix: `ConnectumEnvSchema`, `parseEnvConfig()` and `safeParseEnvConfig()` reject a fractional `PORT` (for example `80.5`) with an issue on `PORT` that states an integer is expected; before, such a value passed validation. The range is unchanged: `1` and `65535` are accepted, `0` and `65536` are rejected. Starting a server on a fractional port was already refused (`ERR_SOCKET_BAD_PORT` for the `port` option, an error naming `PORT` for the variable); tests now pin that.

- [#341](https://github.com/Connectum-Framework/connectum/pull/341) [`01b222c`](https://github.com/Connectum-Framework/connectum/commit/01b222cb8997807e2d5d5dd6676225050427a62f) Thanks [@intech](https://github.com/intech)! - fix: in-process calls advance the caller's request stream in the caller's async context.
  
  In a client-streaming or bidirectional call over `server.localClient()`, `createLocalTransport()`, `ctx.stream` or `server.client()`, the handler pulls the caller's request generator directly, so the generator ran under the `AsyncLocalStorage` values that a server interceptor had scoped around the handler: with `@connectum/auth` the caller's own code observed the identity verified for the callee (for client-streaming calls since 1.0; for bidirectional calls since the streaming identity fix in this release), and with `@connectum/otel` it ran under the server span. The transport now binds the creation of the request iterator and each of its `next`, `return` and `throw` to the context in which the call was made, below the client-side interceptors, as the HTTP transport's pump does: the generator sees the caller's identity, the client span and every other value of the call site. Handlers, server-side interceptors, the identity they verify and their spans are unchanged. On cancellation the generator's `return` and `throw` still run in the context that raised the abort, on both transports. No API changes.

- [#309](https://github.com/Connectum-Framework/connectum/pull/309) [`5f61717`](https://github.com/Connectum-Framework/connectum/commit/5f617172b1074544282eaf9ed9b1287bc8928b20) Thanks [@intech](https://github.com/intech)! - fix: cancelling a streaming call now finishes the handler's output stream on every transport and runtime
  
  - A streaming handler parked at `yield` only unwinds when something pulls its generator again. Over `server.localClient()` / `createLocalTransport()` nothing pulls once the client stops reading, so the handler kept an aborted `ctx.signal` but never reached its `finally`: cursors, subscriptions and handles opened before the `yield` leaked. Over HTTP/2 the server pumps the generator into the socket, but whether a cancelled call is noticed there depends on the runtime: on Node 26.10.0 and under Bun the handler stayed parked as well. Both paths now finish the handler's output iterator when the call's signal aborts (client `AbortSignal`, deadline, `server.stop()`); an abort that arrives while the handler is inside an `await` finishes it right after that step, never concurrently.
  - Leaving a `for await` loop with `break` is still not a cancellation on either transport: the handler keeps running until the call is aborted or the server stops.
  - `@connectum/testing`: two parity scenarios (abort, and break followed by abort) compare what the handler observes on both transports, not only what the client sees.

- [#651](https://github.com/Connectum-Framework/connectum/pull/651) [`70b91ca`](https://github.com/Connectum-Framework/connectum/commit/70b91caeffef5753cef81dccd1bfe2fdd7b50a93) Thanks [@intech](https://github.com/intech)! - fix: every package manifest now carries `homepage` (the package page on https://connectum.dev), `bugs.url` (the repository issue tracker) and one `repository` form (`git+https://github.com/Connectum-Framework/connectum.git` plus the package `directory`). Before, none of the 15 packages declared `homepage` or `bugs`, so the npm package page had no documentation or issue links and `npm docs` / `npm bugs` had nothing to open; the four events adapters also wrote `repository.url` without the `git+` prefix. The release gate now fails if any installed package differs from this form.

- [#325](https://github.com/Connectum-Framework/connectum/pull/325) [`3591014`](https://github.com/Connectum-Framework/connectum/commit/35910149aa614a388cfadbb11968b3deb57aad13) Thanks [@intech](https://github.com/intech)! - docs: the package READMEs are short entry points (install, a runnable start, constraints, links) and the long reference tables now live on the documentation site and in the API reference. The facts that exist only in a README stay there: the cancellation migration notes of `@connectum/interceptors`, the request initializer migration of `@connectum/protoc-gen-catalog`, the dependency injection and testing section of `@connectum/events`, the verified RabbitMQ and Kafka broker lines and the integration-suite instructions of the AMQP and Kafka adapters. Examples in the READMEs of eight packages and the Quickstart are executed against the packed packages by `pnpm docs:check`. JSDoc of a few exports was corrected to match the code; no runtime behavior changes.

- [#277](https://github.com/Connectum-Framework/connectum/pull/277) [`90a5a5f`](https://github.com/Connectum-Framework/connectum/commit/90a5a5fcddb895b8ca2b5a922ea5ca54bdad6ba5) Thanks [@intech](https://github.com/intech)! - Require `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and `@bufbuild/protoplugin` `^2.16.0` and `@connectrpc/connect` / `@connectrpc/connect-node` `^2.2.0`. Generate your code with `protoc-gen-es` 2.16 and keep one `@bufbuild/protobuf` version in your project. When an application pins an older `@bufbuild/protobuf` than the one Connectum resolves, two copies get installed, and message and service types generated against one copy no longer match the other.

- [#347](https://github.com/Connectum-Framework/connectum/pull/347) [`f1a67a6`](https://github.com/Connectum-Framework/connectum/commit/f1a67a6b6babed644e671a24b20cc04bc5ee810f) Thanks [@intech](https://github.com/intech)! - fix: `server.stop()` is idempotent, as the shutdown guide always said. A call after the server has stopped now resolves immediately without repeating the shutdown or emitting events, instead of throwing `Cannot stop server: current state is "stopped"`. Concurrent calls during shutdown still join it and settle with its outcome. Calling `stop()` on a server that was never started (or is still starting) still throws, because that is a lifecycle mistake rather than a repeat. Code that relied on the throw after a stop (for example to detect "already stopped") must check `server.state` instead.

- [#268](https://github.com/Connectum-Framework/connectum/pull/268) [`8ae4fca`](https://github.com/Connectum-Framework/connectum/commit/8ae4fca7c095b8fca74c41c4cb9e93f7695c893e) Thanks [@intech](https://github.com/intech)! - fix: `forceCloseOnTimeout` now closes every connection, on every transport
  
  `shutdown.forceCloseOnTimeout` (default `true`) is documented to make `server.stop()` finish within `shutdown.timeout` even if clients hold connections open. It only destroyed HTTP/2 sessions, so in several cases a client kept the server — and the process — alive forever:
  
  - the default plaintext transport (HTTP/1.1) with a long, unfinished or idle request;
  - TLS connections that never completed a handshake or a request;
  - h2c clients that ignore GOAWAY, on Node 24+.
  
  On the force-close path the server now destroys every remaining TCP connection of every transport.
  
  The graceful phase also sends GOAWAY to every HTTP/2 session explicitly, including sessions whose TLS handshake completes during the drain. Node 22's `server.close()` does not send GOAWAY, so idle HTTP/2 clients now drain immediately there instead of being cut at the timeout.
  
  `forceCloseOnTimeout: false` still destroys nothing: `stop()` resolves after the timeout and hooks run, but open connections stay open.

- [#271](https://github.com/Connectum-Framework/connectum/pull/271) [`8f82559`](https://github.com/Connectum-Framework/connectum/commit/8f825599513ecff3c34d51965c46aab597e7be38) Thanks [@intech](https://github.com/intech)! - fix: shutdown hooks run even when the listener fails to close, and late TLS sessions are told to go away after dispose
  
  - If closing the transport rejects, `server.stop()` used to skip the shutdown hooks and transport disposal. Hooks release the application's own resources (brokers, databases), so they now always run; the close error is re-thrown afterwards.
  - With `forceCloseOnTimeout: false`, a connection accepted before shutdown whose TLS handshake completes after the timeout now receives GOAWAY instead of being able to serve requests after `stop()`.

- [#292](https://github.com/Connectum-Framework/connectum/pull/292) [`b555978`](https://github.com/Connectum-Framework/connectum/commit/b5559789145656d823b9277f0406e51a14c6251a) Thanks [@intech](https://github.com/intech)! - Each package now evaluates its modules once, whichever subpath you import.
  
  These packages were built with one bundle per subpath, and every bundle carried its own copy of the modules it used. In `@connectum/otel` that meant one provider singleton per subpath: `getProvider()` from `@connectum/otel` and from `@connectum/otel/provider` returned different providers, and the second one's global registration failed with `Attempted duplicate registration of API: trace`, so a tracer or meter taken through a subpath belonged to a provider OpenTelemetry was not using. Likewise `ServerState` from `@connectum/core` and `@connectum/core/types` were two objects, and collectors created by `@connectum/testing/parity` were not `instanceof` the classes exported by `@connectum/testing`.
  
  The builds now share modules between subpaths, so every subpath hands out the same provider, classes and functions. The `exports` maps are unchanged; `dist` gains shared chunk files.

- [#308](https://github.com/Connectum-Framework/connectum/pull/308) [`6f342ac`](https://github.com/Connectum-Framework/connectum/commit/6f342acfb59c296020435b779d7c8f7bd79acee6) Thanks [@intech](https://github.com/intech)! - Internal hardening, no behaviour change: the linter now enforces a stricter rule set
  (no import cycles, no namespace imports, no bitwise operators, no `== null`, no `var`,
  no unguarded `for...in`, and others), and the sources were brought in line with it.
  
  The CIDR check behind the gateway trust source is now plain integer arithmetic instead
  of signed 32-bit shifts, so no prefix length can flip the high bit; every prefix
  boundary, including `/0`, `/1`, `/31` and `/32`, is covered by a test. The catalog
  generator emits its `catalog.gen.ts` through `print(...)` calls rather than tagged
  templates; a test pins the exact generated text line for line.

- [#417](https://github.com/Connectum-Framework/connectum/pull/417) [`93b125f`](https://github.com/Connectum-Framework/connectum/commit/93b125fe672a49219ce20491fdfde41cf09f4f32) Thanks [@intech](https://github.com/intech)! - fix: `tls` with only one of `keyPath` and `certPath` is now a configuration error. Previously `readTLSCertificates` silently ignored the single path and read both `server.key` and `server.crt` from the directory (`dirPath`, `TLS_DIR_PATH` or the default directory), so the server started with a different certificate than the one the operator named. It now throws an `Error` naming the parameter that is set and the one that is missing, before any file is read, and `server.start()` rejects with it. Behaviour correction for that configuration only: set both paths, or neither to read the directory. The precedence of the other sources (both explicit paths, then `dirPath`, then `TLS_DIR_PATH`, then the default directory) and the treatment of an empty string as "not set" are unchanged.

## 1.2.0

## 1.1.0

### Minor Changes

- [#178](https://github.com/Connectum-Framework/connectum/pull/178) [`4b0dccc`](https://github.com/Connectum-Framework/connectum/commit/4b0dccc5463220b1ee0ddf7983fb7a64108ebd39) Thanks [@intech](https://github.com/intech)! - Add `createCatalogClient({ catalog, resolver })` — a standalone, catalog-typed client usable OUTSIDE a `Server`. Out-of-process callers (a Temporal worker, a scheduler, a CLI) now get the same typed, resolver-routed `call` (unary) and `stream` (server/client/bidi) ergonomics as the in-handler `ctx.call`/`ctx.stream`, keyed off the generated `ConnectumCallMap`/`ConnectumStreamMap`, without constructing a `Server`.

  It resolves every target through the supplied `RemoteResolver` (`singleTransportResolver`/`mapResolver`/`dnsResolver`/`perServiceEnvResolver`) and dispatches over the returned `Transport`, caching the transport per `(typeName, endpoint)`. Because there is no in-process/local path, a service the resolver cannot resolve fails with `Code.Unavailable`; the rest of the error model mirrors `ctx.call` (`Unimplemented` for an unknown service/method, `Internal` when the resolver throws). Unlike `ctx.call`, `CallOptions` are applied verbatim — there is no inbound request, so the signal/deadline are not cascaded or clamped, no inbound headers are propagated, and no `ContextValues` are forwarded.

  Additive only: `ctx.call`/`ctx.stream`/`createServer` behavior and public types are unchanged.

### Patch Changes

- [#184](https://github.com/Connectum-Framework/connectum/pull/184) [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae) Thanks [@intech](https://github.com/intech)! - Bump protobuf-es (`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`, `@bufbuild/protoplugin`) to 2.12.1. A workspace `overrides` entry pins `@bufbuild/protobuf` to a single version so transitive consumers (`@lambdalisue/connectrpc-grpcreflect`, `@bufbuild/protovalidate`) don't split `@connectrpc/connect`'s protobuf peer into two incompatible instances. Generated code is unchanged; published packages now declare `@bufbuild/protobuf` `^2.12.1`.

## 1.0.0

### Major Changes

- [#141](https://github.com/Connectum-Framework/connectum/pull/141) [`917dca7`](https://github.com/Connectum-Framework/connectum/commit/917dca78e2554299026efe6c66c487e2b97ed302) Thanks [@intech](https://github.com/intech)! - **BREAKING** (behavioral): startup validation of bidi-streaming methods vs the effective transport.

  Per the Connect protocol, bidirectional streaming requires HTTP/2 — but the default `createServer()` transport without TLS is plaintext HTTP/1.1 (`allowHTTP1: true`). Previously a bidi service registered cleanly on that transport and failed silently at runtime: the first client send hung forever (or yielded HTTP 505). Now `server.start()` rejects with a `TransportValidationError` carrying the stable code `CONNECTUM_UNSUPPORTED_STREAMING_TRANSPORT`, the affected `service.method` list with streaming kinds, and both fixes (`allowHTTP1: false` for h2c, or TLS with ALPN). The rejected promise and the `error` event carry the same error object.

  New option:

  ```typescript
  createServer({
    // "error" (default) — fail fast at start()
    // "warn"  — log the diagnostic once and start anyway
    // "off"   — skip the check
    transportValidation: "error" | "warn" | "off",
  });
  ```

  Unary, server-streaming, and client-streaming methods are unaffected on any transport (the Connect protocol supports them over HTTP/1.1). A TLS server that also allows HTTP/1.1 (`allowHTTP1: true`) emits a one-time **warning** for bidi methods — never a hard error — because a client negotiating HTTP/1.1 over TLS hits the same hang; set `allowHTTP1: false` to refuse HTTP/1.1 at ALPN and remove the risk. A TLS or h2c server restricted to HTTP/2 never triggers the check.

  Deployments that knowingly ran bidi services on an HTTP/1.1-permitting config (they were broken at runtime) can downgrade with `transportValidation: "warn"` or `"off"`. Exported: `TransportValidationError`, `TRANSPORT_VALIDATION_ERROR_CODE`, `collectStreamingMethods`.

- [#129](https://github.com/Connectum-Framework/connectum/pull/129) [`4cef99b`](https://github.com/Connectum-Framework/connectum/commit/4cef99b469f7399993319a436fa11fd4747ffd2f) Thanks [@intech](https://github.com/intech)! - chore: raise minimum supported Node.js to 22.13.0

  The `engines.node` requirement for all packages is raised from `>=20.0.0` to
  `>=22.13.0`. Node.js 20 reached end-of-life on 2026-04-30 and no longer receives
  security updates.

  Node.js 22 is the current LTS line. Consumers on Node.js 20 or earlier must
  upgrade to Node.js 22.13.0 or later. Packages continue to ship compiled
  JavaScript, so no build-step changes are required on the consumer side.

  Marked as a major change because raising the runtime floor is breaking for
  consumers on Node.js 20; it lands in the upcoming 1.0.0 baseline.

- [#152](https://github.com/Connectum-Framework/connectum/pull/152) [`21deccd`](https://github.com/Connectum-Framework/connectum/commit/21deccda4e401b044c5886cd22fdc65a4aad6837) Thanks [@intech](https://github.com/intech)! - feat(core)!: service catalog — declarative cross-service calls

  Adds the **service catalog** layer on top of the in-process transport: a
  standardized DX for calling other services (local or remote) without hand-rolling
  an endpoint registry, a transport cache, or per-call-site interceptor chains.

  New public API (additive):

  - **`defineService(descriptor, handlers)` / `defineLazyService(descriptor, factory)`** —
    the canonical way to register a service. They return a `ServiceDefinition`
    (`{ descriptor, register }`); `createServer({ services })` now takes
    `ServiceDefinition[]`. `defineLazyService` instantiates handlers only when the
    service is mounted locally. Handlers receive a Connectum `Context` (the
    ConnectRPC `HandlerContext` plus `ctx.call` / `ctx.stream`). An optional third
    `options` argument (`ServiceOptions`) forwards per-service handler options —
    e.g. service-scoped `interceptors` and `jsonOptions` — to `router.service()`,
    preserving the capability of the removed `ServiceRoute` form.
  - **`ctx.call(method, request, options?)`** — typed cross-service unary calls
    (`"${typeName}/${Method}"` keys). The framework routes in-process when the
    target is mounted locally and via the `remoteResolver` otherwise. The inbound
    `AbortSignal` and deadline cascade automatically (override via `CallOptions`;
    a caller may shorten the deadline, not extend it).
  - **`ctx.stream(method)`** — typed streaming calls: server-streaming yields an
    `AsyncIterable`; client- and bidi-streaming return push handles
    (`{ send, close }` / `{ send, close, responses }`).
  - **Catalog primitives** — `ServiceCatalog` type, `defineCatalog`, and
    `mergeCatalogs` (with a mandatory runtime duplicate-`typeName` guard), plus the
    `ConnectumCallMap` / `ConnectumStreamMap` module-augmentation targets that make
    `ctx.call` / `ctx.stream` type-safe (generated by `@connectum/protoc-gen-catalog`).
  - **`RemoteResolver`** type and built-in helpers `singleTransportResolver`,
    `mapResolver`, `dnsResolver`, `perServiceEnvResolver` — resolve a remote
    service to a `Transport` (synchronous, lazy, no startup network I/O).
  - **`enabledServices` helpers** — `parseServicesEnv`, `matchServicesPattern`,
    `mergeEnabledServices` for env-driven local activation (full proto typeNames),
    enabling one image to run as a monolith or as any single microservice role.
  - **`propagateHeaders`** — opt-in allow-list of inbound headers copied onto
    outgoing `ctx.call` / `ctx.stream` (empty by default; `defaultPropagateHeaders`
    exports the W3C trace-context set). `outgoingInterceptors` (a
    `@connectrpc/connect.Interceptor[]`) wrap outgoing catalog calls.
  - **`CatalogConfigError`** — a fail-loud configuration error (vs operational
    `ConnectError` codes) for catalog/resolver misconfiguration.

  **BREAKING** (pre-publish, lands before the first stable release): the legacy
  `ServiceRoute = (router) => void` registration form and the `server.client`
  `fallback` option are removed in favour of `defineService` and `remoteResolver`.
  Migrate `(router) => router.service(Desc, impl)` to `defineService(Desc, impl)`.

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

- [#128](https://github.com/Connectum-Framework/connectum/pull/128) [`2ea8170`](https://github.com/Connectum-Framework/connectum/commit/2ea8170443a942a7c897e707595786c25c262180) Thanks [@intech](https://github.com/intech)! - feat(core): expose `jsonOptions` in `createServer()` to control Connect JSON serialization

  `CreateServerOptions` now accepts an optional `jsonOptions` field
  (`Partial<JsonReadOptions & JsonWriteOptions>`) that is threaded through to the
  underlying `connectNodeAdapter`. It applies server-wide, so it also covers
  protocol services registered by the framework (healthcheck, reflection).

  The most common use is emitting fields with implicit presence (proto3 scalar
  `0`, empty string/list, enum default) in JSON responses instead of omitting
  them:

  ```typescript
  const server = createServer({
    services: [routes],
    jsonOptions: { alwaysEmitImplicit: true },
  });
  ```

  For per-service control, the same option can still be passed as the third
  argument of `router.service()` inside a service route.

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

- [#45](https://github.com/Connectum-Framework/connectum/pull/45) [`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c) Thanks [@intech](https://github.com/intech)! - Add EventBus provider with pluggable broker adapters (NATS JetStream, Kafka/Redpanda, Redis Streams).

  **New packages:**

  - `@connectum/events` — Universal event adapter layer with proto-first pub/sub, middleware pipeline, DLQ
  - `@connectum/events-nats` — NATS JetStream adapter with durable consumers
  - `@connectum/events-kafka` — Kafka/Redpanda adapter with consumer groups
  - `@connectum/events-redis` — Redis Streams adapter with XREADGROUP

  **Core integration:**

  - `EventBusLike` interface for server lifecycle integration
  - `createServer({ eventBus })` option with automatic start/stop management

- [#117](https://github.com/Connectum-Framework/connectum/pull/117) [`0f98dfa`](https://github.com/Connectum-Framework/connectum/commit/0f98dfa5f77c37fa995c4b63b7bd5c3f613f2d3e) Thanks [@intech](https://github.com/intech)! - Add in-process transport with automatic local/remote routing via service registry.

  **`@connectum/core`** — new public API for in-process service invocation:

  - `createLocalTransport(server, options?)` — ConnectRPC `Transport` bound to the server's router; supports client-side interceptors.
  - `server.client(service, options?)` — auto-routing client factory: in-process if `service` is registered on this server, else `options.fallback`, else fail-fast `ConnectError(unimplemented)`.
  - `server.localClient(service)` — low-level helper that always returns an in-process client.
  - `server.hasService(desc)` — synchronous service registry lookup by `desc.typeName`.

  The in-process transport runs the full server-side interceptor chain (validation, authorization, OpenTelemetry), supports unary and all streaming RPCs, propagates `Headers` and `AbortSignal`, and preserves 1-to-1 behavioural parity with the HTTP/gRPC transport. Strictly additive — no breaking changes.

  **`@connectum/testing`** — helpers for cross-transport testing:

  - `createLocalClient(server, service)` — concise client for unit and integration tests without binding ports.
  - `transportParityTest(name, scenario)` — driver that runs one declarative scenario against both `createGrpcTransport` and `createLocalTransport`, structurally diffs the observable outcome (response, headers, `ConnectError`, OTEL spans, metrics), and fails on any divergence.
  - In-memory OTEL `SpanExporter` and `MetricReader` collectors used by the parity driver.

  **`@connectum/otel`** — observability parity for the in-process path:

  - `connectum.transport` span attribute (`in-process` | `http`) on both CLIENT and SERVER spans.
  - `transport` metric label on `rpc.client.call.duration`, `rpc.server.call.duration` and the request and response size histograms (an earlier version of this entry named instruments `rpc.client.duration` and `rpc.server.duration` and an error counter; none of them was ever emitted).
  - W3C Trace Context (`traceparent` / `tracestate`) propagation through in-memory `Headers` so server spans are children of client spans on both transports.

- [#31](https://github.com/Connectum-Framework/connectum/pull/31) [`e3459f8`](https://github.com/Connectum-Framework/connectum/commit/e3459f8d1ed9324a84387c6d298d810803975f95) Thanks [@intech](https://github.com/intech)! - Three transport modes: TLS (createSecureServer), h2c (http2.createServer), HTTP/1.1 (http.createServer).

  New exported types: `TransportServer`, `NodeRequest`, `NodeResponse`.

  `allowHTTP1` option now selects transport mode without TLS: `true` (default) uses HTTP/1.1, `false` uses h2c.

### Patch Changes

- [#13](https://github.com/Connectum-Framework/connectum/pull/13) [`9313d14`](https://github.com/Connectum-Framework/connectum/commit/9313d1445aa22135ba04c0c1dd089f9123e1ab06) Thanks [@intech](https://github.com/intech)! - CI/CD and documentation improvements

  **CI/CD:**

  - Switch to OIDC trusted publishers (no NPM_TOKEN)
  - Add PR snapshot publishing via pkg-pr-new
  - Fix provenance: use NPM_CONFIG_PROVENANCE env var instead of CLI argument

  **Docs:**

  - Fix healthcheck README: clarify Check/Watch (standard) + List (extension), license MIT → Apache-2.0
  - Fix httpHandler.ts JSDoc: HTTP_HEALTH_ENABLED → HealthcheckOptions.httpEnabled
  - Add comprehensive reflection README (API, grpcurl, buf curl usage)

- [`3cb0fcd`](https://github.com/Connectum-Framework/connectum/commit/3cb0fcd5139dd645856902b15b955b99caa59df2) Thanks [@intech](https://github.com/intech)! - Code review: critical fixes, ServerImpl decomposition, HealthcheckManager factory, unit tests

  **core:**

  - Fix Promise.race error swallowing in graceful shutdown
  - Fix error listener leak on synchronous throw in listen()
  - Add concurrent stop() guard
  - Decompose ServerImpl → TransportManager, buildRoutes, gracefulShutdown
  - TLS path validation, emit error instead of process.exit(1)

  **healthcheck:**

  - Add createHealthcheckManager() factory pattern
  - Fix broad catch → AbortError-only in watch stream
  - httpPath → httpPaths: string[] (multiple HTTP paths)
  - Re-initialization merge strategy in HealthcheckManager

  **interceptors:**

  - Add errorHandler unit tests
  - Fix console.time → performance.now() + custom logger
  - Copy request headers in fallback response
  - Improve bulkhead error message
  - Consistent await in serializer
  - Fix double type cast in errorHandler

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

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Add cross-runtime test scripts (`test:bun`, `test:esbuild`) to all packages via `@exodus/test`. Packages with known incompatibilities (interceptors/bun, otel/bun, cli/bun) gracefully skip. Root `test:cross-runtime` runs all runtimes via turbo.

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

- [#156](https://github.com/Connectum-Framework/connectum/pull/156) [`ce69056`](https://github.com/Connectum-Framework/connectum/commit/ce6905671cf15b14f65e57f3f533e13249967cc4) Thanks [@intech](https://github.com/intech)! - fix: re-export `EffectiveTransport` and `TransportValidationMode` as values from the package root

  These are ADR-001 const-object enums — they carry both a runtime value and a type. They were re-exported from the barrel with `export type { … }`, which erased the runtime const: consumers got `undefined` (e.g. `TransportValidationMode.ERROR`, `EffectiveTransport.TLS_H2_ONLY`) while the generated `.d.ts` still advertised them as usable values, so calls type-checked and then crashed (or compared always-false against `resolveEffectiveTransport()`). They are now re-exported as values, carrying both the const and the type.

- [#159](https://github.com/Connectum-Framework/connectum/pull/159) [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb) Thanks [@intech](https://github.com/intech)! - fix: preserve the `node:` protocol prefix on builtin imports

  tsup strips the `node:` prefix from builtin imports by default (`removeNodeProtocol: true`). The bare forms (`crypto`, `fs`, `http2`, …) are valid Node aliases, but the `node:` prefix is the portable specifier across runtimes — Deno resolves builtins prefix-first (bare forms are not guaranteed), and prefix-only builtins like `node:test` have no bare alias at all. Every package now sets `removeNodeProtocol: false`, so the published artifacts keep the prefix on every builtin import for maximum cross-runtime portability (Node / Bun / Deno). No runtime behavior change on Node. (`@connectum/testing` already carried this fix.)

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Security improvements and review fixes.

  **core:**

  - Add `SanitizableError` base class for safe error messages in responses
  - Input validation improvements (code validation, spread pattern)

  **auth:**

  - Header value length limits (256 chars for subject/name/type)
  - Claims JSON size limit in header propagation

  **interceptors:**

  - Error handler respects `SanitizableError` for safe client-facing messages

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

### Minor Changes

- [#45](https://github.com/Connectum-Framework/connectum/pull/45) [`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c) Thanks [@intech](https://github.com/intech)! - Add EventBus provider with pluggable broker adapters (NATS JetStream, Kafka/Redpanda, Redis Streams).

  **New packages:**

  - `@connectum/events` — Universal event adapter layer with proto-first pub/sub, middleware pipeline, DLQ
  - `@connectum/events-nats` — NATS JetStream adapter with durable consumers
  - `@connectum/events-kafka` — Kafka/Redpanda adapter with consumer groups
  - `@connectum/events-redis` — Redis Streams adapter with XREADGROUP

  **Core integration:**

  - `EventBusLike` interface for server lifecycle integration
  - `createServer({ eventBus })` option with automatic start/stop management

## 1.0.0-rc.5

### Minor Changes

- [#31](https://github.com/Connectum-Framework/connectum/pull/31) [`e3459f8`](https://github.com/Connectum-Framework/connectum/commit/e3459f8d1ed9324a84387c6d298d810803975f95) Thanks [@intech](https://github.com/intech)! - Three transport modes: TLS (createSecureServer), h2c (http2.createServer), HTTP/1.1 (http.createServer).

  New exported types: `TransportServer`, `NodeRequest`, `NodeResponse`.

  `allowHTTP1` option now selects transport mode without TLS: `true` (default) uses HTTP/1.1, `false` uses h2c.

## 1.0.0-rc.4

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

### Patch Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Add cross-runtime test scripts (`test:bun`, `test:esbuild`) to all packages via `@exodus/test`. Packages with known incompatibilities (interceptors/bun, otel/bun, cli/bun) gracefully skip. Root `test:cross-runtime` runs all runtimes via turbo.

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Security improvements and review fixes.

  **core:**

  - Add `SanitizableError` base class for safe error messages in responses
  - Input validation improvements (code validation, spread pattern)

  **auth:**

  - Header value length limits (256 chars for subject/name/type)
  - Claims JSON size limit in header propagation

  **interceptors:**

  - Error handler respects `SanitizableError` for safe client-facing messages

## 1.0.0-rc.3

### Patch Changes

- [#13](https://github.com/Connectum-Framework/connectum/pull/13) [`9313d14`](https://github.com/Connectum-Framework/connectum/commit/9313d1445aa22135ba04c0c1dd089f9123e1ab06) Thanks [@intech](https://github.com/intech)! - CI/CD and documentation improvements

  **CI/CD:**

  - Switch to OIDC trusted publishers (no NPM_TOKEN)
  - Add PR snapshot publishing via pkg-pr-new
  - Fix provenance: use NPM_CONFIG_PROVENANCE env var instead of CLI argument

  **Docs:**

  - Fix healthcheck README: clarify Check/Watch (standard) + List (extension), license MIT → Apache-2.0
  - Fix httpHandler.ts JSDoc: HTTP_HEALTH_ENABLED → HealthcheckOptions.httpEnabled
  - Add comprehensive reflection README (API, grpcurl, buf curl usage)

## 1.0.0-rc.2

### Minor Changes

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

### Minor Changes

- 4e784c1: refactor: removed @connectum/utilities package

  **BREAKING**: The `@connectum/utilities` package has been completely removed from the monorepo.

  Reasons for removal:

  - 0 real consumers — no package imported utilities
  - All functions had better alternatives (Node.js built-ins or battle-tested npm packages)
  - 2 critical bugs: timer leak in withTimeout, broken LRU cache (FIFO instead of LRU)
  - 6 out of 9 modules without tests

  Replacement table:

  - `retry()` → `cockatiel` (already in the project)
  - `sleep()` → `import { setTimeout } from 'node:timers/promises'`
  - `withTimeout()` → `AbortSignal.timeout(ms)` (Node.js built-in)
  - `LRUCache` → `lru-cache` npm
  - `safeStringify()` → `safe-stable-stringify` npm
  - `Observable` → `EventEmitter` from `node:events`
  - `Monitor` → `events.on()` from `node:events`

  Relocations:

  - `ConnectumEnvSchema`, `parseEnvConfig`, `safeParseEnvConfig` → `@connectum/core/config`

  Other changes:

  - `@connectum/otel`: removed phantom dependency on utilities (was not used)

### Patch Changes

- Code review: critical fixes, ServerImpl decomposition, HealthcheckManager factory, unit tests

  **core:**

  - Fix Promise.race error swallowing in graceful shutdown
  - Fix error listener leak on synchronous throw in listen()
  - Add concurrent stop() guard
  - Decompose ServerImpl → TransportManager, buildRoutes, gracefulShutdown
  - TLS path validation, emit error instead of process.exit(1)

  **healthcheck:**

  - Add createHealthcheckManager() factory pattern
  - Fix broad catch → AbortError-only in watch stream
  - httpPath → httpPaths: string[] (multiple HTTP paths)
  - Re-initialization merge strategy in HealthcheckManager

  **interceptors:**

  - Add errorHandler unit tests
  - Fix console.time → performance.now() + custom logger
  - Copy request headers in fallback response
  - Improve bulkhead error message
  - Consistent await in serializer
  - Fix double type cast in errorHandler

- Updated dependencies
  - @connectum/interceptors@1.0.0-beta.2

## 0.2.0-beta.1

### Minor Changes

- feat: 5-phase graceful shutdown with `shutdownSignal` and `ShutdownManager` with dependency-ordered hooks
- feat: `builtinInterceptors` option — custom interceptors append after builtins

### Patch Changes

- refactor!: uniform registration API, remove deprecated code
- refactor: update healthcheck references (`withHealthcheck` -> `Healthcheck`)
- chore: clean up package dependencies

## 0.2.0-alpha.2

Initial alpha release.
