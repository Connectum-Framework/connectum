# Threat model

Connectum is a TypeScript framework for building gRPC / ConnectRPC microservices. This
repository is a pnpm monorepo of `@connectum/*` packages that application developers install
from npm. The framework does not run on its own: an application builds a server from it with
`createServer()`, and the findings that matter are the ones an attacker can trigger against
such an application through the framework.

## Deployment model

The intended deployment puts a server behind a gateway or a service mesh (Envoy, Istio) that
terminates mTLS and forwards the caller's identity in headers. The framework authenticates and
authorizes calls from that identity or from a JWT, and it does not assume that a server faces the
internet directly. Consequences for a report:

- A flaw that lets a caller reach a gated method without the credentials the configured trust
  source requires is a vulnerability, in any deployment.
- A flaw that needs the gateway or the mesh to be misconfigured or bypassed (for example, an
  attacker who can already reach the pod network and forge mesh headers) is a configuration
  problem unless the framework's documentation promises protection against it.
- Network-level controls (rate limiting, connection limits, WAF rules) belong to the gateway. The
  framework is still expected to survive a single small malicious request.
- Every transport-level or message-level input is untrusted. That includes messages from brokers:
  the broker is trusted as a transport, but a payload or header can be malformed or hostile, and a
  parse failure must not crash the consumer.

## What this project does and where untrusted input enters

- **Network requests to a server** (`@connectum/core`): HTTP/2 and HTTP/1.1 requests carrying
  gRPC, gRPC-Web or Connect protocol messages. Headers, metadata, message bodies, stream
  frames and request sizes are untrusted.
- **Credentials and identity headers** (`@connectum/auth`): bearer tokens (JWT), session
  data, and identity headers forwarded by a gateway or a service mesh. A token's claims are
  untrusted until verified. Identity headers are trusted only when the configured trust source
  accepts the caller; an attacker-supplied copy of such a header must never reach application
  code as if it were verified.
- **Messages from brokers** (`@connectum/events` and the NATS, Kafka, Redis Streams and AMQP
  adapters): payloads, headers and topic names that arrive from the broker are untrusted,
  including redelivered and malformed messages.
- **Responses from other services** (client interceptors, the service catalog): payloads and
  errors returned by a remote server are untrusted.
- **Developer tooling** (`@connectum/cli`): `connectum init` downloads a project template, and
  `connectum proto sync` reads a remote server's reflection output. Both consume data from
  outside the machine.

## Components that matter most / least

Most important, in this order:

1. `packages/auth`: authentication, authorization, trust of forwarded identity, header
   stripping, the auth context that carries identity through a call.
2. `packages/core`: request handling, TLS and mTLS configuration, request admission, and
   stream handling, graceful shutdown, the in-process transport.
3. `packages/interceptors`: error handling (what an error reveals to the caller), timeouts,
   bulkhead, circuit breaker, retry, fallback, validation.
4. `packages/events` and the four broker adapters: message parsing, acknowledgement and
   redelivery, dead-letter handling.
5. `packages/healthcheck` and `packages/reflection`: protocols that are exposed on the server
   port, sometimes without authentication.

Lower priority (still in scope, but spend effort on the list above first):

- `packages/otel`: telemetry export. It matters when it leaks secrets or request content into
  traces, logs or metrics.
- `packages/cli`: developer-side tool; reports are in scope when untrusted remote data leads to
  code execution or file writes outside the target directory.
- `packages/testing` and `packages/test-fixtures`: test helpers, not shipped into production
  paths. Findings there are low priority unless they weaken what the tests claim to prove.

Out of scope:

- Dependencies (`node_modules`), generated code under `gen/`, and the `docs` and `examples`
  repositories, which are separate.
- Application code that uses the framework unsafely when the documentation says so (for
  example, mounting a method as `public` and then complaining that it needs no token).
- Denial of service that needs an authenticated, intentionally privileged caller.

## How to exercise it

- Each package has `tests/unit` and `tests/integration` directories. The unit suites run
  offline with `pnpm --recursive --if-present run test:unit` after `pnpm build`.
- A server can be started in a few lines with `createServer()` from `@connectum/core`, and the
  in-process transport in `@connectum/testing` calls services without a socket.
- The integration suites for the broker adapters need a running NATS, Kafka, Redis or RabbitMQ
  and cannot run offline. Reason about those paths from the source.

## How you rate severity

These are the maintainers' working rules; a report should say which rule it relies on.

- **Critical**: authentication or authorization bypass on a gated method; forged identity
  accepted from an attacker-controlled header; remote code execution; a secret or token
  disclosed to an unauthenticated caller.
- **High**: a flaw that lets a caller act as another identity or read another caller's data;
  memory or event-loop exhaustion by an unauthenticated caller with a small request; a
  message that crashes the server process.
- **Medium**: information disclosure that is not a secret (stack traces, internal messages in
  error responses); denial of service that needs sustained, high-volume traffic; weak defaults
  that are documented.
- **Low**: hardening gaps with no demonstrated path to impact.

A finding needs a reproducer that runs against the built packages. A report that depends on a
configuration the documentation marks as unsafe is rated one level lower.

## Anything to leave alone

- Do not report missing authentication on methods the application explicitly marks `public`,
  or on the health-check and reflection protocols when the application chooses to expose them.
- Do not report the use of `sharedSecretTrust`: the documentation states that it is for local
  development only.
- Do not report credentials that appear only in `tests/` fixtures (keys, tokens, certificates):
  they are test data and protect nothing.
- Do not propose patches that change public API shapes; describe the fix and keep the patch
  minimal and backwards compatible.
