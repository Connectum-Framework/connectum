/**
 * Factory for mock ConnectRPC unary request objects.
 *
 * @module
 */

import type { MockRequestOptions } from "./types.ts";

const DEFAULT_SERVICE = "test.TestService";
const DEFAULT_METHOD = "TestMethod";

/**
 * Create a simplified ConnectRPC request fixture for interceptor unit tests.
 *
 * Provides common request fields and an independent, non-aborted signal.
 * Service and method descriptors are minimal mocks. Tests that need
 * requestMethod, contextValues or complete protobuf descriptors must supply
 * those fields separately, or exercise an actual RPC transport.
 *
 * @param options - Optional overrides for request fields.
 * @returns A plain object containing simplified request fields.
 *
 * @example
 * ```ts
 * import { createMockRequest } from "@connectum/testing";
 *
 * const req = createMockRequest({ service: "acme.UserService", method: "GetUser" });
 * // req.service.typeName === "acme.UserService"
 * // req.method.name     === "GetUser"
 * // req.url             === "http://localhost/acme.UserService/GetUser"
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: simplified fixture intentionally omits fields that tests may supply separately
export function createMockRequest(options?: MockRequestOptions): any {
    const serviceName = options?.service ?? DEFAULT_SERVICE;
    const methodName = options?.method ?? DEFAULT_METHOD;
    const stream = options?.stream ?? false;
    const message = options?.message ?? {};
    const url = options?.url ?? `http://localhost/${serviceName}/${methodName}`;
    const headers = options?.headers ?? new Headers();

    return {
        service: { typeName: serviceName },
        method: { name: methodName },
        header: headers,
        url,
        stream,
        message,
        signal: new AbortController().signal,
    };
}
