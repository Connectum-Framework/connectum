---
"@connectum/cli": patch
---

fix: `connectum proto sync` against a server that only speaks HTTP/1.1 now says so. `createServer()` leaves `allowHTTP1` on by default, which on plain TCP makes the server HTTP/1.1-only, and the command talks gRPC over HTTP/2; the failure used to read `ConnectError: [internal] Protocol error` with a stack trace and no address. It is now `Error: HTTP/2 protocol error talking to http://localhost:5311 (Protocol error). The address probably serves HTTP/1.1 only ... unless it is created with allowHTTP1: false.`
