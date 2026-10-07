# @fixture/beta

## 1.0.0

### Minor Changes

- Raise the supported Node.js floor to 22.13.0 so every published package declares the same engine range and the install-time warning is identical across the whole monorepo. Consumers on older Node.js versions must upgrade before installing this release, and the migration guide lists the affected deployment targets one by one.

- Beta-only entry: the health endpoint now answers over cleartext HTTP/2 as well as HTTP/1.1, so a container probe that speaks only prior-knowledge HTTP/2 gets a real answer instead of passing without ever reaching the server process.
