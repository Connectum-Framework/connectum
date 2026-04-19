# @connectum/testing

## 1.0.0-rc.11

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.11

## 1.0.0-rc.10

### Patch Changes

- [#93](https://github.com/Connectum-Framework/connectum/pull/93) [`5671e77`](https://github.com/Connectum-Framework/connectum/commit/5671e775a0bb86fc7e1ed2400304653553bf5b34) Thanks [@intech](https://github.com/intech)! - fix(testing): replace node:test mock with portable implementation

  Replaced `mock.fn()` from `node:test` with a portable `createMockFn()`
  implementation that works across Node.js, Bun, and bundler environments.
  The public API surface (`.mock.calls`, `.mock.callCount()`) is preserved.

  This unblocks Bun users from using `@connectum/testing` utilities.

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.10

## 1.0.0-rc.9

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.9

## 1.0.0-rc.8

### Patch Changes

- Updated dependencies [[`752f6f5`](https://github.com/Connectum-Framework/connectum/commit/752f6f565d5a555d340df68283e0de96ffb1adda)]:
  - @connectum/core@1.0.0-rc.8

## 1.0.0-rc.7

### Patch Changes

- Updated dependencies []:
  - @connectum/core@1.0.0-rc.7

## 1.0.0-rc.6

### Minor Changes

- [#41](https://github.com/Connectum-Framework/connectum/pull/41) [`fccee26`](https://github.com/Connectum-Framework/connectum/commit/fccee264ec7ed685348a7590057ec8316f21ef1a) Thanks [@intech](https://github.com/intech)! - Implement @connectum/testing utilities package with 13 factory functions for ConnectRPC testing.

  **Phase 1 (P0)**: `createMockRequest`, `createMockNext`, `createMockNextError`, `createMockNextSlow`, `assertConnectError`
  **Phase 2 (P1)**: `createMockDescMessage`, `createMockDescField`, `createMockDescMethod`, `createMockStream`, `createFakeService`, `createFakeMethod`
  **Phase 3 (P2)**: `createTestServer`, `withTestServer`

  Eliminates 135+ test boilerplate duplicates across interceptors, auth, otel, and core packages. All migrated packages now use shared testing utilities instead of inline mock objects.

### Patch Changes

- Updated dependencies [[`25992b4`](https://github.com/Connectum-Framework/connectum/commit/25992b4d8beaf6921b9497536cc758b5144d1a7c)]:
  - @connectum/core@1.0.0-rc.6

## 1.0.0-rc.5

### Patch Changes

- Updated dependencies [[`e3459f8`](https://github.com/Connectum-Framework/connectum/commit/e3459f8d1ed9324a84387c6d298d810803975f95)]:
  - @connectum/core@1.0.0-rc.5

## 1.0.0-rc.4

### Minor Changes

- [#24](https://github.com/Connectum-Framework/connectum/pull/24) [`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667) Thanks [@intech](https://github.com/intech)! - Migrate to compile-before-publish with tsup (ADR-001 revision).

  All packages now publish compiled .js + .d.ts + source maps instead of raw .ts source.
  Consumer Node.js requirement lowered from >=25.2.0 to >=18.0.0.

  REMOVED: `@connectum/core/register` — no longer needed, packages ship compiled JS.

### Patch Changes

- Updated dependencies [[`bb40d53`](https://github.com/Connectum-Framework/connectum/commit/bb40d5340dcc2a208eb69a34eb5e22f38068a667), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177), [`ac6f515`](https://github.com/Connectum-Framework/connectum/commit/ac6f515271bb25f7dfb18ac5de59dade5cebe177)]:
  - @connectum/core@1.0.0-rc.4

## 1.0.0-rc.3

### Patch Changes

- Updated dependencies [[`9313d14`](https://github.com/Connectum-Framework/connectum/commit/9313d1445aa22135ba04c0c1dd089f9123e1ab06)]:
  - @connectum/core@1.0.0-rc.3

## 1.0.0-rc.2

### Patch Changes

- Updated dependencies [[`76eb476`](https://github.com/Connectum-Framework/connectum/commit/76eb476298b2bcbbf5cfbd8de682f9dfec9a248e)]:
  - @connectum/core@1.0.0-rc.2

## 1.0.0-beta.2

### Patch Changes

- Updated dependencies
- Updated dependencies [4e784c1]
  - @connectum/core@1.0.0-beta.2

## 0.2.0-beta.1

### Patch Changes

- chore: clean up package dependencies
- chore: update dependencies

## 0.2.0-alpha.2

Initial alpha release.
