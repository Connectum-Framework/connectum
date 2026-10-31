/**
 * Client-side Bearer token interceptor
 *
 * Sets the Authorization header with a Bearer token on outgoing requests.
 * Supports both static tokens and async token factories for refresh flows.
 *
 * @module client-bearer-interceptor
 */

import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { assertClientCredential, describeKind } from "./option-validation.ts";
import type { ClientBearerInterceptorOptions } from "./types.ts";

/**
 * Create a client interceptor that attaches a Bearer token to outgoing requests.
 *
 * The interceptor sets the `Authorization: Bearer <token>` header on every
 * outgoing request. If a token factory function is provided instead of a
 * static string, it is called before each request to support token refresh.
 *
 * @param options - Configuration with a static token or async token factory
 * @returns A ConnectRPC client Interceptor
 * @throws {TypeError} When `token` is neither a non-empty string nor a function
 *
 * A token factory that returns anything but a non-empty string (`undefined` or `null` after a failed
 * refresh) fails that call with `Code.Unauthenticated` before any request is sent; the header is
 * never set to the text `Bearer undefined`.
 *
 * @example Static token
 * ```typescript
 * import { createClientBearerInterceptor } from '@connectum/auth';
 * import { createConnectTransport } from '@connectrpc/connect-node';
 *
 * const transport = createConnectTransport({
 *     baseUrl: 'http://localhost:5000',
 *     interceptors: [createClientBearerInterceptor({
 *         token: 'my-static-jwt-token',
 *     })],
 * });
 * ```
 *
 * @example Async token factory (refresh)
 * ```typescript
 * import { createClientBearerInterceptor } from '@connectum/auth';
 *
 * const transport = createConnectTransport({
 *     baseUrl: 'http://localhost:5000',
 *     interceptors: [createClientBearerInterceptor({
 *         token: async () => {
 *             const { accessToken } = await refreshTokenIfNeeded();
 *             return accessToken;
 *         },
 *     })],
 * });
 * ```
 */
export function createClientBearerInterceptor(options: ClientBearerInterceptorOptions): Interceptor {
    const { token } = options;

    assertClientCredential("createClientBearerInterceptor", "token", token, true);

    return (next) => async (req) => {
        const resolvedToken: unknown = typeof token === "function" ? await token() : token;
        // A factory whose refresh failed may return nothing. Sending `Bearer undefined` would be rejected
        // by the server as an invalid credential, far from the cause, so the call fails here instead.
        if (typeof resolvedToken !== "string" || resolvedToken.length === 0) {
            throw new ConnectError(
                `@connectum/auth: createClientBearerInterceptor token factory returned ${describeKind(resolvedToken)}; expected a non-empty string`,
                Code.Unauthenticated,
            );
        }
        req.header.set("authorization", `Bearer ${resolvedToken}`);
        return await next(req);
    };
}
