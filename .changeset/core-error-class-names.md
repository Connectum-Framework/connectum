---
"@connectum/core": patch
---

fix: the error classes `@connectum/core` exports now keep their public names in the published build. `CatalogConfigError.name` and `PeerDependencyVersionError.name` were `"_CatalogConfigError"` and `"_PeerDependencyVersionError"`, so `constructor.name`, the first line of an uncaught-error trace on Node and the output of `console.log(error)` showed the underscore. The cause was a `setPrototypeOf` call that named the class inside its own body, which made the bundler give the class an inner name. The `name` field of an instance was never affected. The release gate now compares `Class.name` of every exported error class of every package with its export name.
