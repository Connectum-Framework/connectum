---
"@connectum/interceptors": patch
---

fix: a `SanitizableError` whose `code` is not an integer from 1 to 16 (`0`, `99`, `NaN`) now reaches the client as `Internal` with its `clientMessage`, as every other failure with an invalid code does. Before it reached the client as `Unknown`. `onError` receives the same code the client gets.
