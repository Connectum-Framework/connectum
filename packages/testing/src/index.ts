/**
 * @connectum/testing — Testing utilities for the Connectum framework.
 *
 * Provides mock factories, assertion helpers, and a test server utility
 * to eliminate boilerplate in ConnectRPC interceptor and service tests.
 *
 * @packageDocumentation
 */

export { assertConnectError } from "./assertions.ts";
export { createFakeMethod, createFakeService } from "./fake-service.ts";
// Phase 2 (P1): Protobuf descriptor mocks & streaming
export { createMockDescField, createMockDescMessage, createMockDescMethod } from "./mock-desc.ts";
export { createMockNext, createMockNextError, createMockNextSlow } from "./mock-next.ts";
// Phase 1 (P0): Core mocks & assertions
export { createMockRequest } from "./mock-request.ts";
export { createMockStream } from "./mock-stream.ts";
// Phase 3 (P2): Test server
export { createTestServer, withTestServer } from "./test-server.ts";
// Types
export type {
    CreateTestServerOptions,
    FakeMethodOptions,
    FakeServiceOptions,
    MockDescFieldOptions,
    MockDescMessageOptions,
    MockDescMethodOptions,
    MockNextOptions,
    MockRequestOptions,
    MockStreamOptions,
    TestServer,
} from "./types.ts";
