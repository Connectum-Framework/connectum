/**
 * Factory for mock ConnectRPC unary request objects.
 *
 * @module
 */

import type { MockRequestOptions } from "./types.ts";

const DEFAULT_SERVICE = "test.TestService";
const DEFAULT_METHOD = "TestMethod";

/**
 * Create a mock ConnectRPC {@link https://connectrpc.com/docs/node/interceptors | UnaryRequest}
 * object suitable for testing interceptors.
 *
 * All fields have sensible defaults, so calling `createMockRequest()` with no
 * arguments returns a fully valid request that can be passed straight into an
 * interceptor under test.
 *
 * @param options - Optional overrides for request fields.
 * @returns A plain object matching the ConnectRPC `UnaryRequest` shape.
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
    };
}
