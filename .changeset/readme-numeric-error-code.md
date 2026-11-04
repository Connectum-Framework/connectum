---
"@connectum/interceptors": patch
---

docs: the README of `@connectum/interceptors` now states which numeric `code` the error handler passes on: an integer from 1 to 16 is sent with an empty text, any other number (`0`, `17`, `1.5`, `NaN`, an HTTP status, an errno) becomes `Internal` with the text `internal error`.
