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
import { encodeHeaderText, jsonForHeader, MAX_SUBJECT_LENGTH, sanitizeHeaderValue, TEXT_ENCODING_MARKER } from "./headers.ts";
import { assertHeaderValue, assertWritable } from "./option-checks.ts";
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

    // Checked once, here: a bad secret or subject would otherwise fail every call (or be altered on
    // the wire: Headers.set removes a space or tab at either end of the secret, which would then
    // never match). The roles are checked again on every call, because the
    // roles array can be changed after this point.
    assertHeaderValue("createClientGatewayInterceptor secret", secret);
    assertWritable("createClientGatewayInterceptor subject", { subject });
    if (roles !== undefined) assertWritable("createClientGatewayInterceptor roles", { roles });

    return (next) => async (req) => {
        // Check everything before the first header is set. The roles array can have been changed since
        // creation; a list that does not fit is refused, not cut or left out: the service would
        // otherwise authorize a different identity. The writer decides, as at creation.
        if (roles !== undefined) {
            try {
                assertWritable("createClientGatewayInterceptor roles", { roles });
            } catch (err) {
                throw new ConnectError((err as Error).message, Code.InvalidArgument, undefined, undefined, err);
            }
        }
        const rolesValue = roles && roles.length > 0 ? jsonForHeader(roles) : undefined;

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
