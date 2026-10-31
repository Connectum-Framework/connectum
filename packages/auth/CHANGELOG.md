# @connectum/auth

## 1.3.0

### Minor Changes

- [#654](https://github.com/Connectum-Framework/connectum/pull/654) [`9cb7438`](https://github.com/Connectum-Framework/connectum/commit/9cb743851ac6158a3a39e1fc9315ca4aab1d8d09) Thanks [@intech](https://github.com/intech)! - fix(security): the `authorize` callback of `createAuthzInterceptor` and `createProtoAuthzInterceptor` now allows a call only when it returns (or resolves to) exactly `true`. Before, any truthy value allowed: the string `"false"` or `"0"` read from a claim, `1`, `{}`. Every other result is `PermissionDenied: Access denied`, as `false` already was.
  
  **BREAKING** for a callback that returned a truthy non-boolean on purpose: return `true`, for example `authorize: (ctx) => ctx.claims.isAdmin === true`. See the migration guide `auth-authorization-validation`.

- [#654](https://github.com/Connectum-Framework/connectum/pull/654) [`9cb7438`](https://github.com/Connectum-Framework/connectum/commit/9cb743851ac6158a3a39e1fc9315ca4aab1d8d09) Thanks [@intech](https://github.com/intech)! - fix(security): `createAuthzInterceptor` and `createProtoAuthzInterceptor` now throw a `TypeError` when they are created with a `defaultPolicy` or a rule `effect` that is not exactly `"allow"` or `"deny"`, naming the option and the value. Before, any other value (`"Deny"`, `"DENY"`, `"dney"`, `""`, `null`) was read as "allow", so a typo in a configuration file or environment variable opened every method that no rule matched, and a deny rule with `effect: "DENY"` allowed. An omitted `defaultPolicy` is still `"deny"`. At request time the interceptors also treat anything other than the exact `"allow"` as a denial, for a rule whose `effect` was changed after creation.
  
  **BREAKING** for configurations that relied on a misspelled value: the process now fails at startup. Fix the spelling (the values are lowercase `allow` and `deny`) or remove the option to get the default `deny`. See the migration guide `auth-authorization-validation`.

- [#644](https://github.com/Connectum-Framework/connectum/pull/644) [`29a5bdf`](https://github.com/Connectum-Framework/connectum/commit/29a5bdf99a06b0945277e005f179a6f5bcdf6311) Thanks [@intech](https://github.com/intech)! - fix: `createAuthInterceptor` and `createSessionAuthInterceptor` now check the value returned by `verifyCredentials` and `mapSession`. A result that is not an `AuthContext` (`null`, `undefined`, `false`, `{}`, a string, or an object whose `subject`, `type`, `roles`, `scopes` or `claims` is missing or has the wrong type (`roles` and `scopes` must be arrays of at most 8192 strings and without holes; a sparse list, or a list that holds `undefined`, `null` or a number, is refused, so is a list of `String` objects or a proxy that reports a length that is not a non-negative safe integer within the limit, and so is an object whose property read throws), or whose `name` or `expiresAt` is mistyped) ends the call with `Unauthenticated` (`Authentication failed` / `Session mapping failed`) and is not cached, with `propagateHeaders` on or off. Before, such a result made the call fail with `internal` when `propagateHeaders` was on, and let the handler run without an identity when it was off. The steps that follow the check are held to the same outcome: if copying the identity for the cache or writing it into headers fails (a context property or a `claims` key whose getter throws, a proxy whose trap throws, a cyclic or `BigInt` claim, a value whose `toJSON` throws), the call ends with `Unauthenticated` instead of the raw error, and nothing is cached. The internal-auth interceptor treats a custom trust source result that is not an `AuthContext` like `null`. A callback that returned a partial object and relied on it being accepted must now return the complete `AuthContext`.

- [#654](https://github.com/Connectum-Framework/connectum/pull/654) [`9cb7438`](https://github.com/Connectum-Framework/connectum/commit/9cb743851ac6158a3a39e1fc9315ca4aab1d8d09) Thanks [@intech](https://github.com/intech)! - fix(auth): `createClientBearerInterceptor` no longer sends the text `undefined` or `null` as a credential. A static `token` that is not a non-empty string throws a `TypeError` when the interceptor is created, and a token factory that resolves to `undefined`, `null`, an empty string or any non-string fails that call on the client with `Unauthenticated` and a message that names the interceptor, before a request is sent. Before, the server received `Authorization: Bearer undefined` or `Bearer null` and rejected it as an invalid credential, far from the missing configuration.
  **BREAKING** for code that passed an unset value on purpose and relied on the server rejecting the call: fix the configuration, or omit the interceptor for unauthenticated calls. See the migration guide `auth-authorization-validation`.

- [#391](https://github.com/Connectum-Framework/connectum/pull/391) [`1735e1b`](https://github.com/Connectum-Framework/connectum/commit/1735e1b813ebb0af26a796f25e6456ef1a5a4469) Thanks [@intech](https://github.com/intech)! - fix(security): `@connectum/auth` now fails loudly on configurations that used to weaken security silently, and refuses identities that cannot be propagated safely. Documented as contracts as well: `requires { roles: [] }` places no restriction on roles and `requires {}` admits any authenticated caller; the gateway `defaultType` defaults to `"gateway"`; a `ConnectError` thrown by `verifyCredentials`, `verifySession` or `mapSession` reaches the client unchanged (its text is sent verbatim), while any other error becomes a fixed `Authentication failed` / `Session verification failed` / `Session mapping failed`.
  
  **BREAKING** in each of the following. Breaking and shipped as minor on purpose: the `@connectum/*` packages are one fixed version group, so a major here would release every package as 2.0.0.
  
  - **Invalid proto policy.** A `method_auth.policy` or `service_auth.default_policy` value other than the empty string, `allow` or `deny` (a typo such as `"Allow"` or `"dney"`; the check is case-sensitive) throws an `Error` naming the value, the method and the option when the method is resolved, instead of being read as "not set" and handed to the interceptor default. `getPublicMethods` / `getInternalMethods` resolve every method, so the error surfaces at startup when you use them.
  - **Public and internal together.** A method that resolves to both `public` and `internal` (directly or through the service defaults) throws an `Error` suggesting `public: true, internal: false`.
  - **`signedTokenTrust` identity.** `AuthContext.subject` is now the verified `iss`; the `sub` claim is used only when the issuer entry maps it with `claimsMapping.subject` (and a mapped subject that is absent, empty or not a string rejects the call), and the standard `scope` claim no longer grants scopes unless `claimsMapping.scopes` names it. The raw claims stay in `AuthContext.claims`.
  - **Catch-all in `skipMethods`.** `skipMethods: ["*"]` throws when `createAuthInterceptor`, `createJwtAuthInterceptor`, `createSessionAuthInterceptor`, `createGatewayAuthInterceptor` or `createAuthzInterceptor` is created. `"*"` stays valid in the `methods` of an authorization rule and in `internalMethods`.
  - **Unsafe identity with `propagateHeaders`.** A subject, type, name or scope containing NUL, CR, LF or a character above U+00FF (a header value is a byte string, so the platform refuses such a value) is rejected with `Unauthenticated` before the identity is cached, and `setAuthHeaders` throws a `TypeError` naming the field; before, a Cyrillic name ended in an internal error. Roles and claims with characters above U+00FF are now written as JSON `\uXXXX` escapes and read back unchanged, where they used to fail the same way. A gateway `defaultType` containing such a character throws when the interceptor is created. Without `propagateHeaders` such identities are still admitted.
  - **Cache bounds.** `cache.ttl` must be finite and greater than 0 and `cache.maxSize` an integer of at least 1; anything else, `NaN` and `Infinity` included, throws a `RangeError` when the interceptor is created.
  
  **Migration:** see the migration guide `auth-proto-options`. Fix the policy spelling (or remove the option to use the interceptor default); drop `public` or `internal` from a method that has both; in `signedTokenTrust` add `claimsMapping: { subject: "sub", scopes: "scope" }` to the issuers that relied on those claims; replace `skipMethods: ["*"]` by not registering the interceptor or by listing `Service/*` patterns; make the identity provider return a subject, name and scopes without line breaks or NUL (or keep `propagateHeaders` off); give the cache a finite `ttl` and an integer `maxSize` of at least 1.

- [#644](https://github.com/Connectum-Framework/connectum/pull/644) [`29a5bdf`](https://github.com/Connectum-Framework/connectum/commit/29a5bdf99a06b0945277e005f179a6f5bcdf6311) Thanks [@intech](https://github.com/intech)! - fix: `createGatewayAuthInterceptor` throws when `trustSource.expectedValues` contains an IPv4 CIDR block (such as `10.0.0.0/8`) unless `trustSource.allowCallerControlledCidr: true` is set. A block is matched against the value of the trust header, and a caller that reaches the service directly chooses that value, so `10.0.0.0/8` or `0.0.0.0/0` admitted anyone who sent a matching address as if the request had come through the gateway. Shared secrets are unchanged, including secrets that contain a `/` without being a well-formed block. A deployment whose trusted upstream overwrites that header on every request and that no client can reach directly sets the option; trust based on the connection's peer address belongs in the mTLS and mesh-identity trust helpers.

- [#644](https://github.com/Connectum-Framework/connectum/pull/644) [`29a5bdf`](https://github.com/Connectum-Framework/connectum/commit/29a5bdf99a06b0945277e005f179a6f5bcdf6311) Thanks [@intech](https://github.com/intech)! - fix: with `propagateHeaders` on, an identity that does not fit its `x-auth-*` header is now rejected with `Unauthenticated` (`Authentication failed`, not cached) instead of being cut or left out: a `subject` over 512 characters, a `type` over 128, a `name` over 256, or roles, scopes or claims whose serialized value is over 8192 characters (after the `propagatedClaims` filter). Before, two subjects that shared their first 512 characters became one identity downstream, and a role, scope or claim list over the limit was silently omitted, so a deny rule or an `authorize` callback that looks at it stopped matching. The readers are fail-closed too: `parseAuthHeaders` throws `Unauthenticated` for a value over its limit, `createGatewayAuthInterceptor` rejects a claims header over 8192 characters instead of reading `{}`, and, for the standard `x-auth-*` names it maps, a subject over 512 characters, a type over 128, a name over 256 or a roles or scopes header over 8192 characters, whether or not `propagateHeaders` is on (a header mapped under a custom name is still taken as sent, and refused only when the identity is propagated), and `createClientGatewayInterceptor` throws at creation for a subject over 512 characters or roles that do not fit the roles header (measured as the writer measures them, with every character above U+00FF expanded to six), and `InvalidArgument` per call if the roles array was changed afterwards, instead of cutting or omitting them. `setAuthHeaders` throws a `RangeError` (`HeaderValueTooLargeError`) and sets no header. The limit is measured on the text as it arrives, before the writer or a reader removes C0 controls and DEL, so a value one character over the limit whose extra character is a control is refused, not accepted shortened. A service that propagates identities near these limits must shorten them or turn propagation off.

- [#654](https://github.com/Connectum-Framework/connectum/pull/654) [`9cb7438`](https://github.com/Connectum-Framework/connectum/commit/9cb743851ac6158a3a39e1fc9315ca4aab1d8d09) Thanks [@intech](https://github.com/intech)! - fix(security): `createProtoAuthzInterceptor` now admits an `internal` method that has no `requires` only for an identity established by `createInternalAuthInterceptor`. Before, any `AuthContext` was enough, so an end-user JWT reached the method when `createInternalAuthInterceptor` was missing from the chain, was given `internalMethods: []`, or did not list the method. Any other identity now ends the call with `Unauthenticated: Untrusted internal request`. The documented chain (the JWT interceptor skips internal methods, the internal interceptor runs before proto authz) is unchanged. An `internal` method with `requires` keeps checking roles and scopes as before.
  
  **BREAKING** for a chain that fed `internal` methods from another interceptor (a custom one, the gateway interceptor, the session interceptor): authenticate those callers with `createInternalAuthInterceptor` and a trust source, as the proto authorization guide describes. See the migration guide `auth-authorization-validation`.

- [#654](https://github.com/Connectum-Framework/connectum/pull/654) [`9cb7438`](https://github.com/Connectum-Framework/connectum/commit/9cb743851ac6158a3a39e1fc9315ca4aab1d8d09) Thanks [@intech](https://github.com/intech)! - fix(security): `createJwtAuthInterceptor` no longer switches a check off when its option is falsy. An empty `issuer` or `audience` string used to skip the check, so a token from any issuer for any audience was accepted, typically after `issuer: process.env.ISSUER ?? ""`; the interceptor now throws a `TypeError` that names the option. `maxTokenAge: 0`, `NaN` and an empty string used to skip the age check too; they now throw a `RangeError`. Values that were truthy and unusable were passed to jose and never matched or always failed (an array with an empty entry, a negative or infinite number, a whitespace-only string, a duration text jose cannot read such as `"1month"`, a text jose reads as zero or negative such as `"0s"`, `"-1h"` or `"1h ago"`, which makes every token older than the limit); these throw at creation as well, instead of rejecting tokens at request time. An omitted option still means "do not check", and an empty array still matches no token. The per-issuer `audience` and `maxTokenAge` of `signedTokenTrust` follow the same rules.
  
  **BREAKING** for a configuration that passed an empty value to skip a check: omit the option instead. See the migration guide `auth-authorization-validation`.

- [#654](https://github.com/Connectum-Framework/connectum/pull/654) [`9cb7438`](https://github.com/Connectum-Framework/connectum/commit/9cb743851ac6158a3a39e1fc9315ca4aab1d8d09) Thanks [@intech](https://github.com/intech)! - fix(security): `createJwtAuthInterceptor` now rejects a token whose subject is not a non-empty string with `Unauthenticated: JWT missing subject claim`. Before, a `sub` that was an empty string, a number, a boolean, an array or an object was accepted, so a handler saw `subject: ""` or `subject: 123`, and with `propagateHeaders: true` a numeric `sub` ended the call with `internal`. The same check applies to a subject read through `claimsMapping.subject`.
  
  **BREAKING** for an identity provider that issues tokens with an empty or numeric `sub`: issue a string subject, or map another claim with `claimsMapping.subject`. See the migration guide `auth-authorization-validation`.

- [#654](https://github.com/Connectum-Framework/connectum/pull/654) [`9cb7438`](https://github.com/Connectum-Framework/connectum/commit/9cb743851ac6158a3a39e1fc9315ca4aab1d8d09) Thanks [@intech](https://github.com/intech)! - fix(security): `@connectum/auth` now refuses a method pattern it cannot match when an interceptor is created. Only `"*"`, `"Service/*"` and `"Service/Method"` match anything; a partial wildcard (`"Service/Write*"`, `"acme.v1.*/*"`), a bare service name or a leading slash was accepted and silently never matched, so a `deny` rule written that way did nothing and a `skipMethods` entry skipped nothing. `createAuthInterceptor`, `createJwtAuthInterceptor`, `createSessionAuthInterceptor`, `createGatewayAuthInterceptor` and `createAuthzInterceptor` check `skipMethods`, `createAuthzInterceptor` and `createProtoAuthzInterceptor` check the `methods` of every rule, and `createInternalAuthInterceptor` checks `internalMethods`. The error is a `TypeError` that names the option (and the rule) and the pattern.
  
  **BREAKING** for a configuration that carried such a pattern: replace it with exact methods or a complete `Service/*` pattern. See the migration guide `auth-authorization-validation`.

- [#644](https://github.com/Connectum-Framework/connectum/pull/644) [`29a5bdf`](https://github.com/Connectum-Framework/connectum/commit/29a5bdf99a06b0945277e005f179a6f5bcdf6311) Thanks [@intech](https://github.com/intech)! - fix: with `propagateHeaders` on, a `subject`, `name`, `type` or scope that contains characters above U+00FF (Cyrillic, CJK, an emoji) is now admitted instead of rejected with `Unauthenticated`. It is written to the `x-auth-*` header as `utf-8''` followed by its percent-encoded UTF-8 bytes (the form of an RFC 8187 `ext-value`) and decoded by `parseAuthHeaders` and by `createGatewayAuthInterceptor` when it reads the standard `x-auth-*` names. When at least one text was encoded, the writer also sets `x-auth-encoding: percent-utf8`, and readers decode `utf-8''` texts only when that header is present, so a literal `utf-8''admin` subject from an older service or another gateway stays that literal text. ASCII and Latin-1 identities are written as before, with no extra header, with two exceptions that are encoded as well. A text that starts with `utf-8''` is encoded so that reading is unambiguous. A text with a space or tab at either end is encoded because `Headers.set` removes such whitespace from every header value: a subject of U+0020 followed by `alice` used to reach the next hop as `alice`, and the two subjects were one identity. This covers `subject`, `name`, `type`, each scope and a gateway `defaultType`; roles and claims are JSON and start with a bracket or brace, so they are not affected. NUL, CR, LF, a lone surrogate and a scope with a space are still rejected on write. The readers hold a decoded text to the same rules as a raw one: a decoded text with NUL, CR or LF (a percent-encoded `%00`, `%0D`, `%0A`) is refused with `Unauthenticated`, and other C0 controls and DEL are removed from a subject, type or name as the writer removes them; a scope is read as granted. `createGatewayAuthInterceptor` applies the same rules to the standard `x-auth-*` names it maps, raw or decoded; a header mapped under a custom name is still taken as sent. A downstream service that reads `x-auth-subject` or `x-auth-name` without `@connectum/auth` sees the encoded form for such users and should decode it when `x-auth-encoding` is present. `createClientGatewayInterceptor` encodes a non-Latin subject the same way. `defaultType` may now contain characters above U+00FF.

- [#348](https://github.com/Connectum-Framework/connectum/pull/348) [`429669a`](https://github.com/Connectum-Framework/connectum/commit/429669aea6fc9fd9643aa302339214b98def1a28) Thanks [@intech](https://github.com/intech)! - fix(security): `createJwtAuthInterceptor` and `signedTokenTrust` now reject a signed token that has no `exp` (expiration time) claim. RFC 9068 section 2.2 requires `exp` in a JWT access token, and `jose` only checks it when it is present, so a token minted without it never expired: a leaked one stayed valid until the signing key was rotated.
  
  **BREAKING** for issuers that mint tokens without `exp`. Breaking and shipped as minor on purpose: the `@connectum/*` packages are one fixed version group, so a major here would release every package as 2.0.0. Tokens from mainstream identity providers always carry `exp` and are unaffected. **Migration:** make the issuer add an expiration (preferred), or opt out explicitly with `requireExpiration: false` on `createJwtAuthInterceptor` options or on the issuer entry of `signedTokenTrust`. An expired token is rejected in both modes.

- [#654](https://github.com/Connectum-Framework/connectum/pull/654) [`9cb7438`](https://github.com/Connectum-Framework/connectum/commit/9cb743851ac6158a3a39e1fc9315ca4aab1d8d09) Thanks [@intech](https://github.com/intech)! - fix(auth): `createGatewayAuthInterceptor`, `createInternalAuthInterceptor` and `createAuthInterceptor` now check the options they cannot work without when they are created, and the error names the factory and the option. Before, `expectedValues: [process.env.GATEWAY_SECRET]` with the variable unset, a missing `internalMethods` or a missing `verifyCredentials` produced an interceptor that failed every request with a bare `internal` or `Authentication failed`, and a missing `trustSource` threw an unlabelled `TypeError`. A bad `expectedValues` entry is reported by index and kind only, never by value, because it may be a secret.
  
  **BREAKING** for code that created these interceptors with unusable options. Most of them rejected every call already. One configuration used to work in part: an `expectedValues` list that holds a valid secret next to an `undefined` or empty entry (`[process.env.GATEWAY_SECRET, process.env.OLD_SECRET]` with the second variable unset) admitted a request that carried the valid secret, and failed with `internal` on any other value. Creation now throws for such a list, so the process stops at startup. Fix the option (drop the unset entry), or do not register the interceptor. See the migration guide `auth-authorization-validation`.

- [#644](https://github.com/Connectum-Framework/connectum/pull/644) [`29a5bdf`](https://github.com/Connectum-Framework/connectum/commit/29a5bdf99a06b0945277e005f179a6f5bcdf6311) Thanks [@intech](https://github.com/intech)! - fix: with `propagateHeaders` on, an identity that holds a scope containing a space is now rejected with `Unauthenticated` (`Authentication failed`) and is not cached, as NUL, CR and LF already are. Scopes travel in `x-auth-scopes` joined by single spaces and are split on a space when read, so the single granted scope `reports read admin` reached the next hop as three scopes, `admin` among them. `setAuthHeaders` throws a `TypeError` naming `scopes` and writes no header. With `propagateHeaders` off the identity is admitted as before. An empty scope is rejected the same way: the reader drops empty pieces, so `["a", "", "b"]` was written as `a  b` and read back as `["a", "b"]`. The error message says a scope may not be empty or contain a space. Every list the writer accepts reads back as written. A verifier that grants empty scopes or scopes with spaces must stop doing so, or turn propagation off.

- [#644](https://github.com/Connectum-Framework/connectum/pull/644) [`29a5bdf`](https://github.com/Connectum-Framework/connectum/commit/29a5bdf99a06b0945277e005f179a6f5bcdf6311) Thanks [@intech](https://github.com/intech)! - fix: string options whose value is used as a header name or written into a header are checked when the interceptor is created, naming the option, instead of failing each request as an internal error. `createGatewayAuthInterceptor` throws for a header name in `headerMapping`, `trustSource.header` or `stripHeaders` that is not a valid HTTP header name, and, with `propagateHeaders` on, for a `defaultType` that is empty, longer than 128 characters or holds a lone surrogate (with `propagateHeaders` off the value is accepted as before). `meshIdentityTrust`, `signedTokenTrust` and `sharedSecretTrust` throw for an invalid `header` name. `createClientGatewayInterceptor` throws for an empty `secret`, a `secret` with a line break, a character above U+00FF or a space or tab at either end (the platform removes that whitespace, so the secret never matched), an empty `subject` or one with a line break or a lone surrogate, and `roles` that is not an array of strings without holes that fits the roles header, with the size measured by the header writer itself (every character above U+00FF takes six characters). The creation-time checks run the operation the request path performs (the header writer, `Headers`) rather than a copy of its rules, so they cannot disagree with it. `setAuthHeaders` refuses an empty subject or type, which the reader reads as absent. A configuration that relied on one of these values must change it.

- [#284](https://github.com/Connectum-Framework/connectum/pull/284) [`b85184a`](https://github.com/Connectum-Framework/connectum/commit/b85184a1b3cd61833e52c8c8aabd880ee4b1f85b) Thanks [@intech](https://github.com/intech)! - Generated code can import Connectum's option descriptors from the packages, and `connectum init` no longer generates its own copies.
  
  - `@connectum/auth` exports `./gen/connectum/auth/v1/options_pb.js` (`file_connectum_auth_v1_options`, `method_auth`, `service_auth`, the `MethodAuth` / `ServiceAuth` / `AuthRequirements` schemas and types), and `@connectum/events` exports `./gen/connectum/events/v1/options_pb.js` (`file_connectum_events_v1_options`, `event`, the `EventOptions` schema and type). Each subpath is the module the package itself uses, so a package evaluates its option proto once and hands out the same descriptor objects through every entry. Point protoc-gen-es (2.15.0 or later) at them with `map_imports=connectum/auth/v1/:@connectum/auth/gen` / `map_imports=connectum/events/v1/:@connectum/events/gen`. `@connectum/events` is now built with code splitting, so its `dist/index.js` imports a shared chunk.
  - `connectum init --auth` / `--events`: the generated `buf.gen.yaml` compiles Connectum's option protos without generating them (one `directory: proto` input, the vendored events option proto under `exclude_paths`) and maps their imports to the packages, so `gen/` no longer holds `connectum/{auth,events}/v1/options_pb.ts`. Every `@connectum/*` dependency of such a project is set to one range: the highest `@connectum/*` requirement of the fetched base, or `^1.3.0` if that is higher (also with `--ref`), so no base entry is lowered. Projects without auth or events are generated exactly as before. Existing projects keep working unchanged.

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

### Patch Changes

- [#654](https://github.com/Connectum-Framework/connectum/pull/654) [`9cb7438`](https://github.com/Connectum-Framework/connectum/commit/9cb743851ac6158a3a39e1fc9315ca4aab1d8d09) Thanks [@intech](https://github.com/intech)! - fix(auth): a denial by an authorization rule or a proto `requires` now reaches the client as `PermissionDenied` even without `createErrorHandlerInterceptor` in front. `AuthzDeniedError` had a `name` that Connect's `instanceof ConnectError` check rejects, so the server turned it into `internal`. The error is now a plain `ConnectError` that carries the same `name`, `ruleName`, `authzDetails`, `clientMessage` and `serverDetails`, so `error.name`, `code` and the error handler output are unchanged; `error instanceof ConnectError` is now true, and `error instanceof AuthzDeniedError` is true only for these errors (before it was false for them and true for every `ConnectError`). Without the error handler the client message is `Access denied by rule: <rule>`; put the handler first to send only `Access denied`. A class that extends `AuthzDeniedError` no longer gets its own prototype.

- [#644](https://github.com/Connectum-Framework/connectum/pull/644) [`29a5bdf`](https://github.com/Connectum-Framework/connectum/commit/29a5bdf99a06b0945277e005f179a6f5bcdf6311) Thanks [@intech](https://github.com/intech)! - fix: with the `cache` option of `createAuthInterceptor` and `createSessionAuthInterceptor`, every request now receives its own copy of the cached `AuthContext` (the context, `roles`, `scopes`, `expiresAt`, and `claims` with its nested plain objects, arrays and dates; other values in `claims`, such as a `Map` or a class instance, are shared). Before, the cache returned the same mutable object to every request with the same credential, so a handler that did `getAuthContext().roles.push("admin")` granted that role to later requests presenting the same token. A handler that changes its context keeps working, as it does without a cache; the change stays inside its request. Each cache hit costs one pass over the identity.

- [#407](https://github.com/Connectum-Framework/connectum/pull/407) [`7d9e22f`](https://github.com/Connectum-Framework/connectum/commit/7d9e22fd682bf144214baa3fe0e0adf2560599be) Thanks [@intech](https://github.com/intech)! - fix: `createGatewayAuthInterceptor` reads a roles header that is valid JSON but not an array (`123`, `true`, `null`) as a comma-separated list, as the guide documents. A trusted gateway that sends the single role `123` now gives the identity the role `"123"` instead of no roles. A JSON array of strings is still used as sent, and non-string array items are still dropped.

- [#644](https://github.com/Connectum-Framework/connectum/pull/644) [`29a5bdf`](https://github.com/Connectum-Framework/connectum/commit/29a5bdf99a06b0945277e005f179a6f5bcdf6311) Thanks [@intech](https://github.com/intech)! - fix: `createGatewayAuthInterceptor` now deletes every standard `x-auth-*` identity header (`x-auth-subject`, `x-auth-type`, `x-auth-name`, `x-auth-roles`, `x-auth-scopes`, `x-auth-claims`, `x-auth-encoding`) after it has read its own input, on admitted requests and on `skipMethods`, as the JWT, generic and session interceptors already did. Before, with `propagateHeaders: true` a client-supplied `x-auth-roles`, `x-auth-scopes`, `x-auth-name` or `x-auth-claims` survived whenever the verified identity had no such field, and a downstream service that trusts those headers saw the forged value. A handler or `propagateHeaders` list that relied on a client-supplied standard `x-auth-*` header passing through the gateway interceptor no longer receives it; the verified identity is still written back with `propagateHeaders: true`, and a gateway that maps `x-auth-*` names in `headerMapping` still reads them.

- [#644](https://github.com/Connectum-Framework/connectum/pull/644) [`29a5bdf`](https://github.com/Connectum-Framework/connectum/commit/29a5bdf99a06b0945277e005f179a6f5bcdf6311) Thanks [@intech](https://github.com/intech)! - fix: `createGatewayAuthInterceptor` compares the trust header with each exact `expectedValues` entry through fixed-size SHA-256 digests and `timingSafeEqual` instead of `===`, so the comparison no longer stops at the first differing character. Which values are trusted does not change.

- [#335](https://github.com/Connectum-Framework/connectum/pull/335) [`f9f5b94`](https://github.com/Connectum-Framework/connectum/commit/f9f5b94d5a75b334ae71d7ab48d05801c2040afb) Thanks [@intech](https://github.com/intech)! - fix: the verified identity now stays available to server-streaming and bidirectional handlers for the whole call.
  
  `getAuthContext()` and `requireAuthContext()` used to return `undefined` in a generator handler as soon as it suspended (after the first `await` or `yield`, and in `finally`), and over `server.localClient()` the handler could instead see the identity held by the caller of the local client. The authentication interceptors (`createAuthInterceptor`, `createJwtAuthInterceptor`, `createSessionAuthInterceptor`, `createGatewayAuthInterceptor`, `createInternalAuthInterceptor`, cached or not) now scope the identity to the creation of the response stream and to each of its `next`, `return` and `throw` operations, so every part of the handler runs under the identity verified for its own call. Unary and client-streaming calls, rejected credentials, response headers and trailers, message order and the early-end semantics are unchanged.
  
  Code that worked around this (capturing the identity before the first `await`, reading the propagated headers, or re-entering `authContextStorage.run` around the iterator) keeps working and can be removed.
  
  `@connectum/core` binds the cleanup it triggers when a streaming call is cancelled (client abort, deadline, server shutdown) to the context in which the call's stream was created, so the handler's `finally` runs under the call's own `AsyncLocalStorage` values instead of those of whatever raised the abort. No public API changes.

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

- [#254](https://github.com/Connectum-Framework/connectum/pull/254) [`d9f9fb4`](https://github.com/Connectum-Framework/connectum/commit/d9f9fb4f3360a906a0404a0feeda45d026a5cadd) Thanks [@intech](https://github.com/intech)! - Add configurable RESP2 and RESP3 Redis Streams support while preserving RESP2 as the backward-compatible default, and refresh the Redis, AMQP testcontainer, and authentication dependencies.

- [#344](https://github.com/Connectum-Framework/connectum/pull/344) [`19d4186`](https://github.com/Connectum-Framework/connectum/commit/19d41860bf52e402d9b3a72ab03cd146b752d9bf) Thanks [@intech](https://github.com/intech)! - fix: the gateway trust header is matched against CIDR blocks with a strict IPv4 parser. Before, `Number()` and `parseInt()` read an empty octet as `0`, accepted hexadecimal and exponent forms, and ignored trailing text in the prefix, so a header value such as `10.0..1` or `0x0a.0.0.1`, or a block such as `10.0.0.0/8abc`, was treated as a well-formed address or block. Now an address is exactly four decimal octets of 0-255 without leading zeros, and a block is such an address plus `/` and a 1-2 digit prefix of 0-32. Anything else matches only its exact text, so a malformed block can never widen trust (a shared secret in `expectedValues` may itself contain `/`). A deployment that relied on one of the lenient forms must send the canonical dotted-decimal address.

- [#651](https://github.com/Connectum-Framework/connectum/pull/651) [`70b91ca`](https://github.com/Connectum-Framework/connectum/commit/70b91caeffef5753cef81dccd1bfe2fdd7b50a93) Thanks [@intech](https://github.com/intech)! - fix: every package manifest now carries `homepage` (the package page on https://connectum.dev), `bugs.url` (the repository issue tracker) and one `repository` form (`git+https://github.com/Connectum-Framework/connectum.git` plus the package `directory`). Before, none of the 15 packages declared `homepage` or `bugs`, so the npm package page had no documentation or issue links and `npm docs` / `npm bugs` had nothing to open; the four events adapters also wrote `repository.url` without the `git+` prefix. The release gate now fails if any installed package differs from this form.

- [#325](https://github.com/Connectum-Framework/connectum/pull/325) [`3591014`](https://github.com/Connectum-Framework/connectum/commit/35910149aa614a388cfadbb11968b3deb57aad13) Thanks [@intech](https://github.com/intech)! - docs: the package READMEs are short entry points (install, a runnable start, constraints, links) and the long reference tables now live on the documentation site and in the API reference. The facts that exist only in a README stay there: the cancellation migration notes of `@connectum/interceptors`, the request initializer migration of `@connectum/protoc-gen-catalog`, the dependency injection and testing section of `@connectum/events`, the verified RabbitMQ and Kafka broker lines and the integration-suite instructions of the AMQP and Kafka adapters. Examples in the READMEs of eight packages and the Quickstart are executed against the packed packages by `pnpm docs:check`. JSDoc of a few exports was corrected to match the code; no runtime behavior changes.

- [#277](https://github.com/Connectum-Framework/connectum/pull/277) [`90a5a5f`](https://github.com/Connectum-Framework/connectum/commit/90a5a5fcddb895b8ca2b5a922ea5ca54bdad6ba5) Thanks [@intech](https://github.com/intech)! - Require `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and `@bufbuild/protoplugin` `^2.16.0` and `@connectrpc/connect` / `@connectrpc/connect-node` `^2.2.0`. Generate your code with `protoc-gen-es` 2.16 and keep one `@bufbuild/protobuf` version in your project. When an application pins an older `@bufbuild/protobuf` than the one Connectum resolves, two copies get installed, and message and service types generated against one copy no longer match the other.

- [#308](https://github.com/Connectum-Framework/connectum/pull/308) [`6f342ac`](https://github.com/Connectum-Framework/connectum/commit/6f342acfb59c296020435b779d7c8f7bd79acee6) Thanks [@intech](https://github.com/intech)! - Internal hardening, no behaviour change: the linter now enforces a stricter rule set
  (no import cycles, no namespace imports, no bitwise operators, no `== null`, no `var`,
  no unguarded `for...in`, and others), and the sources were brought in line with it.
  
  The CIDR check behind the gateway trust source is now plain integer arithmetic instead
  of signed 32-bit shifts, so no prefix length can flip the high bit; every prefix
  boundary, including `/0`, `/1`, `/31` and `/32`, is covered by a test. The catalog
  generator emits its `catalog.gen.ts` through `print(...)` calls rather than tagged
  templates; a test pins the exact generated text line for line.

## 1.2.0

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.2.0

## 1.1.0

### Minor Changes

- [#179](https://github.com/Connectum-Framework/connectum/pull/179) [`3ecb55f`](https://github.com/Connectum-Framework/connectum/commit/3ecb55f2969e55224f0b47338da8237d1b82c48a) Thanks [@intech](https://github.com/intech)! - Add a first-class `internal` (service-to-service) auth marker and interceptor (ADR-029), distinct from `public`. An `internal` method skips end-user (JWT) authentication but **requires an internal trust marker** — so promoting a method `public → internal` removes world-open exposure instead of merely renaming it, and the contract now audits as "internal" rather than "public".

  - **Proto:** `optional bool internal` added to `ServiceAuth` and `MethodAuth` (`connectum/auth/v1/options.proto`, additive). `resolveMethodAuth` surfaces `internal` with the same method-overrides-service precedence as `public`.
  - **`createInternalAuthInterceptor`** — for `internal` methods, authorizes via a pluggable per-service **trust source** (`(req) => AuthContext | null`) and rejects a missing/invalid marker as `Code.Unauthenticated`; non-`internal` methods are a no-op pass-through. Three trust-source factories ship:
    - **`meshIdentityTrust({ allowlist, header? })`** — production default; verify a mesh-forwarded peer principal (Istio short-form ServiceAccount / SPIFFE id) against an allow-list carrying roles/scopes. Per-service by construction (the mesh issues each workload its own identity). The identity header is stripped after extraction (anti-spoofing).
    - **`signedTokenTrust({ issuers, header? })`** — non-mesh per-service containment via per-service JWT/JWKS. **The JWKS lookup is issuer-bound**: the keyset is selected by the token's `iss` claim (`issuers[iss].jwksUri`, one `createRemoteJWKSet` per issuer) and verification is pinned to that same issuer. A single shared JWKS across issuers does NOT contain compromise (jose resolves the signing key by `kid` independently of `iss`), so a token claiming `iss: B` signed with A's key is rejected.
    - **`sharedSecretTrust({ secret, header? })`** — **dev-only** fallback (single shared secret, constant-time compared). NOT per-service — one compromise forges all callers — and documented as such.
  - **`getInternalMethods(services)`** — mirrors `getPublicMethods`; feed both into the JWT interceptor's `skipMethods`.
  - **`createProtoAuthzInterceptor`** composes `internal` inclusively within its existing flow (one model, no parallel `requires_identity`): `internal` + identity + no `requires` → allow; `internal` + `requires {roles/scopes}` → the existing roles/scopes check against the internal identity; `internal` + no identity → `Unauthenticated`. The internal/JWT interceptors MUST run before `createProtoAuthzInterceptor` (they populate the `AuthContext` it consumes): `errorHandler → (jwtAuth | internalAuth) → protoAuthz`.

  Purely additive — existing `public` and gated behavior are unchanged.

- [#175](https://github.com/Connectum-Framework/connectum/pull/175) [`c51bc7e`](https://github.com/Connectum-Framework/connectum/commit/c51bc7ef6391bb908435eb933e98d4b3a94b9eff) Thanks [@intech](https://github.com/intech)! - Add RS256 + JWKS test helpers to `@connectum/auth/testing`. The existing `createTestJwt` is HS256-only, but the production-realistic path with an external IdP is RS256 validated through a JWKS endpoint (`createJwtAuthInterceptor({ jwksUri })`). The new `generateRsaTestKeypair()`, `startTestJwksServer()`, and `createTestJwtRS256()` let you test that path without hand-rolling a keypair + JWKS server + minter — the minted token is verified through the same `createRemoteJWKSet` branch production uses.

### Patch Changes

- [#184](https://github.com/Connectum-Framework/connectum/pull/184) [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae) Thanks [@intech](https://github.com/intech)! - Bump protobuf-es (`@bufbuild/protobuf`, `@bufbuild/protoc-gen-es`, `@bufbuild/protoplugin`) to 2.12.1. A workspace `overrides` entry pins `@bufbuild/protobuf` to a single version so transitive consumers (`@lambdalisue/connectrpc-grpcreflect`, `@bufbuild/protovalidate`) don't split `@connectrpc/connect`'s protobuf peer into two incompatible instances. Generated code is unchanged; published packages now declare `@bufbuild/protobuf` `^2.12.1`.

- Updated dependencies [[`4b0dccc`](https://github.com/Connectum-Framework/connectum/commit/4b0dccc5463220b1ee0ddf7983fb7a64108ebd39), [`2e22eca`](https://github.com/Connectum-Framework/connectum/commit/2e22eca2425050a2eff4c9b741e3f7d3bbe176ae)]:
  - @connectum/core@1.1.0

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

- [#30](https://github.com/Connectum-Framework/connectum/pull/30) [`745619d`](https://github.com/Connectum-Framework/connectum/commit/745619d718e915e381293ba71c231e691eae0208) Thanks [@intech](https://github.com/intech)! - Proto-based authorization via custom options in `.proto` files.

  New `createProtoAuthzInterceptor()` — authorization based on proto options.
  Proto reader for extracting auth options from DescFile.
  Fix: lazy auth context in proto-authz interceptor.
  tsup splitting enabled.

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Add gateway, session interceptors, LRU cache, and security hardening (v2).

  **New interceptors:**

  - `createGatewayAuthInterceptor()` — extract auth context from trusted gateway headers (replaces dead code `createTrustedHeadersReader`)
  - `createSessionAuthInterceptor()` — convenience wrapper for session/cookie-based auth (better-auth, lucia, etc.) with LRU caching

  **LRU cache:**

  - `LruCache<T>` — minimal in-memory cache with TTL + max-size eviction
  - Opt-in via `cache: { ttl, maxSize }` in session and generic auth interceptors

  **Security fixes:**

  - SEC-001: `propagatedClaims` filter prevents PII leak in header propagation
  - SEC-002: reject JWT without `sub` claim (previously fell back to "unknown")
  - SEC-005: sanitize `subject` and `type` header values

  **Header propagation:**

  - `AUTH_HEADERS.NAME` added for name propagation
  - `setAuthHeaders` / `parseAuthHeaders` support name field

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

- [#92](https://github.com/Connectum-Framework/connectum/pull/92) [`4800ce8`](https://github.com/Connectum-Framework/connectum/commit/4800ce8ed8f063680b2d6e3def9d4f59bd2a8217) Thanks [@intech](https://github.com/intech)! - feat(auth): add client-side auth interceptors (bearer, gateway)

  Added two client interceptor factories:

  - `createClientBearerInterceptor()` — sets Authorization header with static or async token
  - `createClientGatewayInterceptor()` — sets gateway secret and auth context headers for service-to-service communication

- [#26](https://github.com/Connectum-Framework/connectum/pull/26) [`e209b5c`](https://github.com/Connectum-Framework/connectum/commit/e209b5cac4f0f8eabb6e88d9d80389917ac5d47e) Thanks [@intech](https://github.com/intech)! - Change JWT key resolution priority from `jwksUri > secret > publicKey` to `jwksUri > publicKey > secret`.

  Asymmetric keys are cryptographically stronger than symmetric secrets, so `publicKey` now takes precedence over `secret` when both are provided. Also improved `publicKey` JSDoc with supported algorithms (RSA, RSA-PSS, EC, EdDSA) and `crypto.subtle.importKey()` examples.

### Patch Changes

- [#78](https://github.com/Connectum-Framework/connectum/pull/78) [`913cafe`](https://github.com/Connectum-Framework/connectum/commit/913cafeb34cdac8d988ee592aca3cd31d3543f69) Thanks [@intech](https://github.com/intech)! - fix(auth): make authContextStorage resilient to multiple module evaluations

  Uses globalThis + Symbol.for() to ensure a single AsyncLocalStorage instance
  per process, even when the module is evaluated through multiple runtime paths
  (e.g., tsx source + built workspace output in dev).

  Emits a one-time `CONNECTUM_AUTH_DUP_INIT` warning when dual initialization
  is detected, helping diagnose mixed src/dist import issues.

  Fixes [#75](https://github.com/Connectum-Framework/connectum/issues/75). Thanks to @kebr0m for the detailed bug report and root cause analysis.

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

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Security improvements and review fixes.

  **core:**

  - Add `SanitizableError` base class for safe error messages in responses
  - Input validation improvements (code validation, spread pattern)

  **auth:**

  - Header value length limits (256 chars for subject/name/type)
  - Claims JSON size limit in header propagation

  **interceptors:**

  - Error handler respects `SanitizableError` for safe client-facing messages

- Updated dependencies [[`9313d14`](https://github.com/Connectum-Framework/connectum/commit/9313d1445aa22135ba04c0c1dd089f9123e1ab06), [`3cb0fcd`](https://github.com/Connectum-Framework/connectum/commit/3cb0fcd5139dd645856902b15b955b99caa59df2), [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667), [`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda), [`917dca7`](https://github.com/Connectum-Framework/connectum/commit/917dca78e2554299026efe6c66c487e2b97ed302), [`2ea8170`](https://github.com/Connectum-Framework/connectum/commit/2ea8170443a942a7c897e707595786c25c262180), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`76eb476`](https://github.com/Connectum-Framework/connectum/commit/76eb476298b2bcbbf5cfbd8de682f9dfec9a248e), [`a839d37`](https://github.com/Connectum-Framework/connectum/commit/a839d3700e76a83e243f5a7154991c72add266b4), [`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c), [`ce69056`](https://github.com/Connectum-Framework/connectum/commit/ce6905671cf15b14f65e57f3f533e13249967cc4), [`66164ac`](https://github.com/Connectum-Framework/connectum/commit/66164acd3709fd1e1ec61ab12142b46e5dedb9bb), [`0f98dfa`](https://github.com/Connectum-Framework/connectum/commit/0f98dfa5f77c37fa995c4b63b7bd5c3f613f2d3e), [`4cef99b`](https://github.com/Connectum-Framework/connectum/commit/4cef99b469f7399993319a436fa11fd4747ffd2f), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`21deccd`](https://github.com/Connectum-Framework/connectum/commit/21deccda4e401b044c5886cd22fdc65a4aad6837), [`e3459f8`](https://github.com/Connectum-Framework/connectum/commit/e3459f8d1ed9324a84387c6d298d810803975f95)]:
  - @connectum/core@1.0.0

## 1.0.0-rc.11

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.11

## 1.0.0-rc.10

### Minor Changes

- [#92](https://github.com/Connectum-Framework/connectum/pull/92) [`4800ce8`](https://github.com/Connectum-Framework/connectum/commit/4800ce8ed8f063680b2d6e3def9d4f59bd2a8217) Thanks [@intech](https://github.com/intech)! - feat(auth): add client-side auth interceptors (bearer, gateway)

  Added two client interceptor factories:

  - `createClientBearerInterceptor()` — sets Authorization header with static or async token
  - `createClientGatewayInterceptor()` — sets gateway secret and auth context headers for service-to-service communication

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.10

## 1.0.0-rc.9

### Patch Changes

- [#78](https://github.com/Connectum-Framework/connectum/pull/78) [`913cafe`](https://github.com/Connectum-Framework/connectum/commit/913cafeb34cdac8d988ee592aca3cd31d3543f69) Thanks [@intech](https://github.com/intech)! - fix(auth): make authContextStorage resilient to multiple module evaluations

  Uses globalThis + Symbol.for() to ensure a single AsyncLocalStorage instance
  per process, even when the module is evaluated through multiple runtime paths
  (e.g., tsx source + built workspace output in dev).

  Emits a one-time `CONNECTUM_AUTH_DUP_INIT` warning when dual initialization
  is detected, helping diagnose mixed src/dist import issues.

  Fixes [#75](https://github.com/Connectum-Framework/connectum/issues/75). Thanks to @kebr0m for the detailed bug report and root cause analysis.

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.9

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

- Updated dependencies [[`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda)]:
  - @connectum/core@1.0.0-rc.8

## 1.0.0-rc.7

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.7

## 1.0.0-rc.6

### Patch Changes

- Updated dependencies [[`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c)]:
  - @connectum/core@1.0.0-rc.6

## 1.0.0-rc.5

### Minor Changes

- [#30](https://github.com/Connectum-Framework/connectum/pull/30) [`745619d`](https://github.com/Connectum-Framework/connectum/commit/745619d718e915e381293ba71c231e691eae0208) Thanks [@intech](https://github.com/intech)! - Proto-based authorization via custom options in `.proto` files.

  New `createProtoAuthzInterceptor()` — authorization based on proto options.
  Proto reader for extracting auth options from DescFile.
  Fix: lazy auth context in proto-authz interceptor.
  tsup splitting enabled.

- [#26](https://github.com/Connectum-Framework/connectum/pull/26) [`e209b5c`](https://github.com/Connectum-Framework/connectum/commit/e209b5cac4f0f8eabb6e88d9d80389917ac5d47e) Thanks [@intech](https://github.com/intech)! - Change JWT key resolution priority from `jwksUri > secret > publicKey` to `jwksUri > publicKey > secret`.

  Asymmetric keys are cryptographically stronger than symmetric secrets, so `publicKey` now takes precedence over `secret` when both are provided. Also improved `publicKey` JSDoc with supported algorithms (RSA, RSA-PSS, EC, EdDSA) and `crypto.subtle.importKey()` examples.

### Patch Changes

- Updated dependencies [[`e3459f8`](https://github.com/Connectum-Framework/connectum/commit/e3459f8d1ed9324a84387c6d298d810803975f95)]:
  - @connectum/core@1.0.0-rc.5

## 1.0.0-rc.4

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Add gateway, session interceptors, LRU cache, and security hardening (v2).

  **New interceptors:**

  - `createGatewayAuthInterceptor()` — extract auth context from trusted gateway headers (replaces dead code `createTrustedHeadersReader`)
  - `createSessionAuthInterceptor()` — convenience wrapper for session/cookie-based auth (better-auth, lucia, etc.) with LRU caching

  **LRU cache:**

  - `LruCache<T>` — minimal in-memory cache with TTL + max-size eviction
  - Opt-in via `cache: { ttl, maxSize }` in session and generic auth interceptors

  **Security fixes:**

  - SEC-001: `propagatedClaims` filter prevents PII leak in header propagation
  - SEC-002: reject JWT without `sub` claim (previously fell back to "unknown")
  - SEC-005: sanitize `subject` and `type` header values

  **Header propagation:**

  - `AUTH_HEADERS.NAME` added for name propagation
  - `setAuthHeaders` / `parseAuthHeaders` support name field

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

### Patch Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177) Thanks [@intech](https://github.com/intech)! - Security improvements and review fixes.

  **core:**

  - Add `SanitizableError` base class for safe error messages in responses
  - Input validation improvements (code validation, spread pattern)

  **auth:**

  - Header value length limits (256 chars for subject/name/type)
  - Claims JSON size limit in header propagation

  **interceptors:**

  - Error handler respects `SanitizableError` for safe client-facing messages

- Updated dependencies [[`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177)]:
  - @connectum/core@1.0.0-rc.4
