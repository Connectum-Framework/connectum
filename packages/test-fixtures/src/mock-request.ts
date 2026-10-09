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
 * This is a minimal request fixture for interceptors that read the supplied
 * service name, method name, headers, URL, stream flag, or message. It omits
 * other ConnectRPC request fields, so use a real request when the code under
 * test depends on the full `UnaryRequest` contract.
 *
 * @param options - Optional overrides for request fields.
 * @returns A partial request object with `service.typeName`, `method.name`,
 *   `header`, `url`, `stream`, and `message` fields.
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
// biome-ignore lint/suspicious/noExplicitAny: mock object matches ConnectRPC UnaryRequest shape
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
