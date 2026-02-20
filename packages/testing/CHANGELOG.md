# @connectum/testing

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
