---
"@connectum/testing": minor
---

fix: `createTestServer()` and `withTestServer()` listen on `127.0.0.1` by default instead of all interfaces (`0.0.0.0`), and `CreateTestServerOptions` gets a `host` option. The test server has no authentication and its client runs in the same process, so it was reachable from the network for the duration of a test run for no reason. `baseUrl` is unchanged for the default (`http://localhost:<port>`); with `host` it points at the address that was bound (`0.0.0.0` and `::` are reached as `localhost`). **Behaviour change:** a test that reaches the test server from another container or host has to ask for it with `host: "0.0.0.0"`. A `host` that is not a non-empty string throws a `TypeError` naming the option. The `LISTEN` environment variable no longer moves the test server, because the helper always passes a host. An IPv6 literal other than `::` (such as `::1`) is not usable on Node.js, see the JSDoc of `host`.
