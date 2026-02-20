---
"@connectum/core": minor
---

Three transport modes: TLS (createSecureServer), h2c (http2.createServer), HTTP/1.1 (http.createServer).

New exported types: `TransportServer`, `NodeRequest`, `NodeResponse`.

`allowHTTP1` option now selects transport mode without TLS: `true` (default) uses HTTP/1.1, `false` uses h2c.
