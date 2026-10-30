/**
 * Client-side gateway service-to-service auth interceptor
 *
 * Sets gateway authentication headers on outgoing requests for
 * service-to-service communication behind an API gateway.
 *
 * @module client-gateway-interceptor
 */

import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { encodeHeaderText, MAX_HEADER_BYTES, MAX_SUBJECT_LENGTH, sanitizeHeaderValue, TEXT_ENCODING_MARKER } from "./headers.ts";
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
        // Check everything before the first header is set. A subject or roles list that does not fit
        // is refused, not cut or left out: the service would otherwise authorize a different identity.
        if (subject.length > MAX_SUBJECT_LENGTH) {
            throw new ConnectError(`createClientGatewayInterceptor: subject is longer than ${MAX_SUBJECT_LENGTH} characters`, Code.InvalidArgument);
        }
        const rolesValue = roles && roles.length > 0 ? JSON.stringify(roles).replace(/[Ā-￿]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`) : undefined;
        if (rolesValue !== undefined && rolesValue.length > MAX_HEADER_BYTES) {
            throw new ConnectError(
                `createClientGatewayInterceptor: roles do not fit the ${AUTH_HEADERS.ROLES} header (limit ${MAX_HEADER_BYTES} characters)`,
                Code.InvalidArgument,
            );
        }

        req.header.set(GATEWAY_SECRET_HEADER, secret);
        const subjectValue = encodeHeaderText(sanitizeHeaderValue(subject, MAX_SUBJECT_LENGTH));
        req.header.set(AUTH_HEADERS.SUBJECT, subjectValue);
        // An existing marker stays: other x-auth-* texts already on the request may be encoded.
        if (subjectValue !== sanitizeHeaderValue(subject, MAX_SUBJECT_LENGTH)) {
            req.header.set(AUTH_HEADERS.ENCODING, TEXT_ENCODING_MARKER);
        }
        if (rolesValue !== undefined) {
            req.header.set(AUTH_HEADERS.ROLES, rolesValue);
        }

        return await next(req);
    };
}
