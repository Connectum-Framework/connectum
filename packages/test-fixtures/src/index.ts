/**
 * @connectum/test-fixtures — Mock factories and assertion helpers for Connectum tests.
 *
 * Transport-free (no `@connectum/core` dependency) so every Connectum package
 * can depend on it without creating workspace build cycles.
 *
 * @packageDocumentation
 */

export { assertConnectError } from "./assertions.ts";
export { createFakeMethod, createFakeService } from "./fake-service.ts";
export type { MockCall, MockFn } from "./mock-compat.ts";
export { createMockFn } from "./mock-compat.ts";
export { createMockDescField, createMockDescMessage, createMockDescMethod } from "./mock-desc.ts";
export { createMockNext, createMockNextError, createMockNextSlow } from "./mock-next.ts";
export { createMockRequest } from "./mock-request.ts";
export { createMockStream } from "./mock-stream.ts";

// Option types
export type {
    FakeMethodOptions,
    FakeServiceOptions,
    MockDescFieldOptions,
    MockDescMessageOptions,
    MockDescMethodOptions,
    MockNextOptions,
    MockRequestOptions,
    MockStreamOptions,
} from "./types.ts";
