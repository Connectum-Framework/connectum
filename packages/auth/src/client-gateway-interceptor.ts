/**
 * Client-side gateway service-to-service auth interceptor
 *
 * Sets gateway authentication headers on outgoing requests for
 * service-to-service communication behind an API gateway.
 *
 * @module client-gateway-interceptor
 */

import type { Interceptor } from "@connectrpc/connect";
import { MAX_HEADER_BYTES, sanitizeHeaderValue } from "./headers.ts";
import type { ClientGatewayInterceptorOptions } from "./types.ts";
import { AUTH_HEADERS } from "./types.ts";

/**
 * Header name for the gateway shared secret.
 *
 * This is the standard header used by Connectum gateway interceptors
 * to establish trust between services.
 */
const GATEWAY_SECRET_HEADER = "x-gateway-secret";

/**
 * Create a client interceptor that attaches gateway auth headers to outgoing requests.
 *
 * Sets the following headers for service-to-service communication:
 * - `x-gateway-secret` — shared secret for trust verification
 * - `x-auth-subject` — authenticated subject identifier
 * - `x-auth-roles` — JSON-encoded roles array (optional)
 *
 * These headers are consumed by the server-side {@link createGatewayAuthInterceptor}
 * to reconstruct the auth context without re-authentication.
 *
 * @param options - Gateway auth configuration
 * @returns A ConnectRPC client Interceptor
 *
 * @example Service-to-service call
 * ```typescript
 * import { createClientGatewayInterceptor } from '@connectum/auth';
 * import { createConnectTransport } from '@connectrpc/connect-node';
 *
 * const transport = createConnectTransport({
 *     baseUrl: 'http://internal-service:5000',
 *     interceptors: [createClientGatewayInterceptor({
 *         secret: process.env.GATEWAY_SECRET!,
 *         subject: 'order-service',
 *         roles: ['service', 'order-writer'],
 *     })],
 * });
 * ```
 */
export function createClientGatewayInterceptor(options: ClientGatewayInterceptorOptions): Interceptor {
    const { secret, subject, roles } = options;

    return (next) => async (req) => {
        req.header.set(GATEWAY_SECRET_HEADER, secret);
        req.header.set(AUTH_HEADERS.SUBJECT, sanitizeHeaderValue(subject, 512));

        if (roles && roles.length > 0) {
            const rolesValue = JSON.stringify(roles);
            if (rolesValue.length <= MAX_HEADER_BYTES) {
                req.header.set(AUTH_HEADERS.ROLES, rolesValue);
            }
        }

        return await next(req);
    };
}
