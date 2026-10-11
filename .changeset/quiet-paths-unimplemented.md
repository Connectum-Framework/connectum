---
"@connectum/core": minor
---

feat: a call to a procedure or service the server does not serve is answered with `unimplemented` encoded in the protocol of the request

Until now every request that matched no route and no protocol HTTP handler received a bare `404 Not Found` with a text body. A client that follows the protocols reads a 404 as `unimplemented` on its own, but it got no error object, no end-of-stream envelope and no `grpc-status`. The server now answers an RPC call in the request's own encoding:

- Connect unary: HTTP 501 with a JSON body `{"code":"unimplemented","message":"procedure not found: /<service>/<method>"}`.
- Connect streaming: HTTP 200 with a single end-of-stream envelope carrying the error.
- gRPC: `grpc-status: 12` with a percent-encoded `grpc-message` (Trailers-Only, no body).
- gRPC-Web: a single trailers frame carrying `grpc-status: 12` and `grpc-message`.

The message names the requested path, cut to 200 characters; on gRPC and gRPC-Web every byte outside `0x20–0x7E` and every `%` is percent-encoded, so no byte of the path can alter the response. Requests that are not served RPC calls — `GET`, a path that is not `/<service>/<method>`, `application/grpc-web-text`, any other content type — keep the plain `404 Not Found`, and protocol HTTP handlers (health, custom) still answer first. The encoding is written out from the protocol text rather than taken from `@connectrpc/connect`'s `@private` encoders, which carry no semver guarantee.

Behavior change: code that matched the old bare `404` for an unknown RPC procedure now sees HTTP 501 on Connect unary and HTTP 200 with a protocol status on gRPC, gRPC-Web and Connect streaming.
