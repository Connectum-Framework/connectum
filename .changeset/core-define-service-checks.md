---
"@connectum/core": minor
---

fix: mistakes in service definitions now fail where they are made, with the service named. `defineService` throws a `TypeError` when the handlers are not an object or a member is not a function; `defineLazyService` applies the same check to the factory result when the factory runs, so `start()` no longer fails with "Cannot convert undefined or null to object" and an `async` factory (which used to mount a service whose every method was `unimplemented`) is rejected with a message that says the factory must be synchronous. Defining the same service twice is rejected by `createServer()` and `addService()` with `CatalogConfigError` naming the type name; before, the last definition silently won. A method that is left out is still allowed and answers `unimplemented`.
