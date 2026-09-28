---
"@connectum/core": patch
---

fix: `forceCloseOnTimeout` now closes every connection, on every transport

`shutdown.forceCloseOnTimeout` (default `true`) is documented to make `server.stop()` finish within `shutdown.timeout` even if clients hold connections open. It only destroyed HTTP/2 sessions, so in several cases a client kept the server — and the process — alive forever:

- the default plaintext transport (HTTP/1.1) with a long, unfinished or idle request;
- TLS connections that never completed a handshake or a request;
- h2c clients that ignore GOAWAY, on Node 24+.

On the force-close path the server now destroys every remaining TCP connection of every transport.

The graceful phase also sends GOAWAY to every HTTP/2 session explicitly, including sessions whose TLS handshake completes during the drain. Node 22's `server.close()` does not send GOAWAY, so idle HTTP/2 clients now drain immediately there instead of being cut at the timeout.

`forceCloseOnTimeout: false` still destroys nothing: `stop()` resolves after the timeout and hooks run, but open connections stay open.
