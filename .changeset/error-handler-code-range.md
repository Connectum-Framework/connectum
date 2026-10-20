---
"@connectum/interceptors": patch
---

fix: `errorHandler` adopts the numeric `code` of a thrown value that is not a `ConnectError` only when it is an integer from 1 to 16 (`Canceled` to `Unauthenticated`). Any other number (`0`, `17`, a fraction, `NaN`, an HTTP status, a system errno) now counts as no code: every client (gRPC, Connect, gRPC-Web, `localClient()`) receives `Internal` with the text `internal error`, and `onError` receives `Internal`; the original error keeps its own `code`.

Behaviour change for handlers that threw an object with such a number: the client used to get a transport-dependent result (over gRPC and gRPC-Web `0` became a protocol error with `Unimplemented`, `17` or `404` became `Internal` with the text `invalid grpc-status: N`, `1.5` or `1e21` became `Canceled`; over Connect and in-process every one of them became `Unknown`). To send a specific code, throw a `ConnectError`.
