---
"@connectum/testing": minor
---

Implement @connectum/testing utilities package with 13 factory functions for ConnectRPC testing.

**Phase 1 (P0)**: `createMockRequest`, `createMockNext`, `createMockNextError`, `createMockNextSlow`, `assertConnectError`
**Phase 2 (P1)**: `createMockDescMessage`, `createMockDescField`, `createMockDescMethod`, `createMockStream`, `createFakeService`, `createFakeMethod`
**Phase 3 (P2)**: `createTestServer`, `withTestServer`

Eliminates 135+ test boilerplate duplicates across interceptors, auth, otel, and core packages. All migrated packages now use shared testing utilities instead of inline mock objects.
