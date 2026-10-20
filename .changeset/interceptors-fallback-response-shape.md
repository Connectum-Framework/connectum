---
"@connectum/interceptors": patch
---

fix: the response synthesised by the fallback interceptor carries only the protocol headers it needs. Its header holds the request `content-type` and, for gRPC and gRPC-web, its trailer holds `grpc-status: 0`; no other header of the request is copied into it. Connect, gRPC and gRPC-web clients now accept the response over HTTP/2 and HTTP/1.1. Code that read its own request headers back from a fallback response, on a server chain or on a client transport, no longer finds them there; metadata the caller needs belongs in the message the `handler` returns.

Why: until now the interceptor answered with a copy of the live request header object and an empty trailer. That had two effects.

- **Request headers came back to the caller.** The copy contained every header of the call at that point of the chain, including the `x-auth-*` identity headers that the authentication interceptors write with `propagateHeaders: true` (the documented order puts authentication outside the default interceptors, so they were already there) and the request's own `authorization` and cookie headers. They were returned to the caller in the response header. Nothing was sent to anyone else, but a header that exists to reach downstream services should not travel back to the client, where proxies, caches and client-side logging can record it.
- **Most clients rejected the response.** The copied request headers and the empty trailer replaced what the protocol layer had prepared: the response lost its own `content-type` handling and, for gRPC and gRPC-web, `grpc-status`, so those clients reported a missing status, and Connect over chunked HTTP/1.1 failed as well. Measured with six client configurations (Connect over HTTP/2 with JSON and with protobuf, gRPC over HTTP/2, gRPC-web over HTTP/2, Connect over HTTP/1.1 with a chunked request body, gRPC-web over HTTP/1.1), four of them got a protocol error from the old response.

The fix is an allow-list of what the response needs, not a copy: `content-type`, and `grpc-status: 0` for `application/grpc*` content types (matched case-insensitively). A Connect GET request carries no `content-type`, so it is taken from the `encoding` query parameter (`json` or `proto`). The interceptor is opt-in (it needs a `handler`), and streaming calls are still skipped unless configured otherwise.
