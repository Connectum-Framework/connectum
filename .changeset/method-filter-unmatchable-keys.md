---
"@connectum/interceptors": minor
---

fix: `createMethodFilterInterceptor` now refuses at creation a key that can never match a call, such as `/Unary`, `acme.v1.Svc/`, `*/*`, `acme.v1.Svc/Un*`, `a/b/*` or a key with a space. Before, such a key was accepted and its interceptors silently never ran, so a guard (authorization, audit) registered under a mistyped key was inactive. A key must be `*`, `Service/*` or `Service/Method`, with a non-empty `Service` and `Method` that contain no `*`, `/` or whitespace. A value that is not an array of functions (a string, `null`, a `null` or `undefined` entry that used to be skipped) and a map that is not an object now throw a `TypeError` naming the key. Valid maps behave as before. Names are still compared exactly, so a well-formed key with the wrong case is not caught.
