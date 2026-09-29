---
"@connectum/core": patch
---

fix: shutdown hooks run even when the listener fails to close, and late TLS sessions are told to go away after dispose

- If closing the transport rejects, `server.stop()` used to skip the shutdown hooks and transport disposal. Hooks release the application's own resources (brokers, databases), so they now always run; the close error is re-thrown afterwards.
- With `forceCloseOnTimeout: false`, a connection accepted before shutdown whose TLS handshake completes after the timeout now receives GOAWAY instead of being able to serve requests after `stop()`.
