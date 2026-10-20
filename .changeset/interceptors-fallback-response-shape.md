---
"@connectum/interceptors": patch
---

fix: the response synthesised by the fallback interceptor carries only the protocol headers it needs. Its header holds the request `content-type` and, for gRPC and gRPC-web, its trailer holds `grpc-status: 0`; no other header of the request is copied into it. Connect, gRPC and gRPC-web clients now accept the response over HTTP/2 and HTTP/1.1. Code that read its own request headers back from a fallback response, on a server chain or on a client transport, no longer finds them there; metadata the caller needs belongs in the message the `handler` returns.
