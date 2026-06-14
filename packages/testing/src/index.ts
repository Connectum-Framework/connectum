/**
 * @connectum/testing — Testing utilities for the Connectum framework.
 *
 * Provides a test server utility, in-process transport helpers, OTel
 * collectors, and a cross-transport parity driver to eliminate boilerplate
 * in ConnectRPC service tests.
 *
 * Mock factories, assertion helpers and protobuf descriptor fixtures now
 * live in `@connectum/test-fixtures`. They are re-exported from this entry
 * for backwards compatibility — existing imports from `@connectum/testing`
 * continue to work unchanged.
 *
 * @packageDocumentation
 */

export type { MockCall, MockFn } from "@connectum/test-fixtures";
// Re-export every mock / assertion / fixture symbol from @connectum/test-fixtures
// for backwards compatibility with existing consumers.
export {
    assertConnectError,
    createFakeMethod,
    createFakeService,
    createMockDescField,
    createMockDescMessage,
    createMockDescMethod,
    createMockFn,
    createMockNext,
    createMockNextError,
    createMockNextSlow,
    createMockRequest,
    createMockStream,
} from "@connectum/test-fixtures";

// Phase 4 (P3): In-process transport helpers & cross-transport parity driver
export { createLocalClient } from "./createLocalClient.ts";
export {
    InMemoryMetricCollector,
    InMemorySpanCollector,
    type NormalizedMetric,
    type NormalizedSpan,
    TRANSPORT_METRIC_ATTRIBUTE,
    TRANSPORT_SPAN_ATTRIBUTE,
} from "./otel-collectors.ts";
// Phase 3 (P2): Test server
export { createTestServer, withTestServer } from "./test-server.ts";
// NOTE: `transportParityTest` and `defaultCompare` are intentionally NOT
// re-exported from this entry. They live under `@connectum/testing/parity`
// because the driver pulls in `node:test`, which esbuild rewrites to a
// bare `"test"` specifier when bundled — breaking every consumer that
// imports the main entry. The parity entry keeps that surface isolated.

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
