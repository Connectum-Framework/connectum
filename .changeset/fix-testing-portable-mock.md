---
"@connectum/testing": patch
---

fix(testing): replace node:test mock with portable implementation

Replaced `mock.fn()` from `node:test` with a portable `createMockFn()`
implementation that works across Node.js, Bun, and bundler environments.
The public API surface (`.mock.calls`, `.mock.callCount()`) is preserved.

This unblocks Bun users from using `@connectum/testing` utilities.
