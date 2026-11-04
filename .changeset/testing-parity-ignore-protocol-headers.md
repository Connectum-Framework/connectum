---
"@connectum/testing": patch
---

fix: `defaultCompare` of `transportParityTest` no longer fails a scenario that reports response headers, trailers or `ConnectError.metadata` exactly as the client sees them. The HTTP/2 and in-process legs carry different protocol headers for identical behaviour (`content-type`, `content-length`, `date`, `grpc-encoding`, `grpc-status`, `grpc-message`); `content-type`, `content-length`, `content-encoding`, `accept-encoding`, `date`, `te` and the `grpc-*` and `connect-*` name families are now left out on both sides before comparing, and every other entry is still compared literally. A scenario that must compare a protocol header passes its own `compare`.
