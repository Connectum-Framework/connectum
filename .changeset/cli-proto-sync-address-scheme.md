---
"@connectum/cli": patch
---

fix: `connectum proto sync --from` decides whether it got a URL by the shape of the address, not by its first letters

- A bare `host:port` always gets `http://` in front of it. Before, any address whose host name merely began with the letters `http` (`httpbin.local:5000`, `https-proxy.internal:443`) was passed on without a scheme and failed with `Invalid URL`.
- An address that starts with `http://` or `https://` is used exactly as typed; the scheme may be written in any letter case.
- An address with any other scheme (`ftp://h:5`, `grpc://h:5`) is refused before a connection is attempted, with a message that names the scheme and lists the accepted forms (`host:port`, `http://...`, `https://...`). Before, it became `http://ftp://h:5` and failed with a resolver error that did not mention the scheme.
