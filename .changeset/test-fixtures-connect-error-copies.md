---
"@connectum/test-fixtures": patch
---

fix: `assertConnectError` says so when the value is a `ConnectError` of another installed copy of `@connectrpc/connect` (`instanceof` fails across copies): the message now reads that it is a `ConnectError` from another copy and that two copies of the package are probably installed, instead of "Expected ConnectError but got ConnectError".
