---
"@connectum/healthcheck": minor
---

fix: the `service` query parameter of the HTTP health endpoint no longer depends on the `Host` header. `parseServiceFromUrl` used to build its base URL from `Host`, so a request with an empty or syntactically invalid `Host` (possible over HTTP/1.1) made the URL constructor throw, the parameter was silently dropped, and `/healthz?service=<name>` answered with the overall state instead of the state of `<name>`. The base is now a constant; the `host` argument of `parseServiceFromUrl` is still accepted but has no effect (it is removed in the next major version).

**BREAKING** configuration check: `Healthcheck()` now validates `httpPaths` whenever it is passed, also with `httpEnabled: false`. An empty array throws `RangeError`; an entry that is not a string, does not start with `/`, or contains `?` or `#` throws `TypeError` (as does a value that is not an array). Before, `httpPaths: []` with `httpEnabled: true` silently left an endpoint that matched nothing, and a malformed entry was accepted and never matched. Shipped as minor on purpose: the `@connectum/*` packages are one fixed version group, so a major here would release every package as 2.0.0. `undefined` still selects the default paths `/healthz`, `/health`, `/readyz`.

**Migration.** To turn the HTTP endpoint off, drop `httpPaths` and set `httpEnabled: false` (or omit `httpEnabled`: it is off by default). Replace any entry without a leading `/` with an absolute path (`"healthz"` becomes `"/healthz"`) and remove `?...` and `#...` parts from entries.

Matching rules, unchanged and now documented and pinned by tests: the request path is compared with the configured paths exactly and case-sensitively (`/healthz/` does not match `/healthz`), the query string is ignored when matching, the request method is not checked, an empty `service=` reports the overall state, and an unknown service answers 404 with `"service": "<name>"`.
