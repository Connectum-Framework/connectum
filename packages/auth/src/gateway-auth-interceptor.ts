/**
 * Gateway authentication interceptor
 *
 * For services behind an API gateway that has already performed authentication.
 * Extracts auth context from gateway-injected headers after verifying trust.
 *
 * Trust is established via a header (e.g., x-gateway-secret) rather than
 * peerAddress, since ConnectRPC interceptors don't have access to peer info.
 *
 * @module gateway-auth-interceptor
 */

import type { Interceptor, StreamRequest, UnaryRequest } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { authContextStorage } from "./context.ts";
import { setAuthHeaders } from "./headers.ts";
import { matchesMethodPattern } from "./method-match.ts";
import type { AuthContext, GatewayAuthInterceptorOptions } from "./types.ts";

/**
 * Match an IP address against a pattern (exact or CIDR notation).
 *
 * Supports:
 * - Exact match: "10.0.0.1"
 * - CIDR range: "10.0.0.0/8"
 */
function isValidOctet(value: number): boolean {
    return Number.isInteger(value) && value >= 0 && value <= 255;
}

function matchesIp(address: string, pattern: string): boolean {
    if (address === pattern) return true;

    if (pattern.includes("/")) {
        const [network, prefixStr] = pattern.split("/");
        if (!network || !prefixStr) return false;
        const prefix = Number.parseInt(prefixStr, 10);
        if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) return false;
        const peerParts = address.split(".").map(Number);
        const networkParts = network.split(".").map(Number);
        if (peerParts.length !== 4 || networkParts.length !== 4) return false;
        if (!peerParts.every(isValidOctet) || !networkParts.every(isValidOctet)) return false;
        const [p0 = 0, p1 = 0, p2 = 0, p3 = 0] = peerParts;
        const [n0 = 0, n1 = 0, n2 = 0, n3 = 0] = networkParts;
        const peerInt = ((p0 << 24) | (p1 << 16) | (p2 << 8) | p3) >>> 0;
        const networkInt = ((n0 << 24) | (n1 << 16) | (n2 << 8) | n3) >>> 0;
        const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
        return (peerInt & mask) === (networkInt & mask);
    }

    return false;
}

/**
 * Check if a trust header value matches any of the expected values.
 *
 * For each expected value, tries exact match first, then CIDR match.
 */
function isTrusted(headerValue: string, expectedValues: readonly string[]): boolean {
    for (const expected of expectedValues) {
        if (headerValue === expected) return true;
        if (expected.includes("/") && matchesIp(headerValue, expected)) return true;
    }
    return false;
}

/**
 * Create a gateway authentication interceptor.
 *
 * Reads pre-authenticated identity from gateway-injected headers.
 * Trust is established by checking a designated header value against
 * a list of expected values (shared secrets or trusted IP ranges).
 *
 * @param options - Gateway auth configuration
 * @returns ConnectRPC interceptor
 *
 * @example Kong/Envoy gateway with shared secret
 * ```typescript
 * const gatewayAuth = createGatewayAuthInterceptor({
 *   headerMapping: {
 *     subject: 'x-user-id',
 *     name: 'x-user-name',
 *     roles: 'x-user-roles',
 *   },
 *   trustSource: {
 *     header: 'x-gateway-secret',
 *     expectedValues: [process.env.GATEWAY_SECRET],
 *   },
 * });
 * ```
 */
export function createGatewayAuthInterceptor(options: GatewayAuthInterceptorOptions): Interceptor {
    const { headerMapping, trustSource, stripHeaders = [], skipMethods = [], propagateHeaders = false, defaultType = "gateway" } = options;

    // Fail-closed: require subject mapping and non-empty expectedValues
    if (!headerMapping.subject) {
        throw new Error("@connectum/auth: Gateway auth requires headerMapping.subject");
    }
    if (trustSource.expectedValues.length === 0) {
        throw new Error("@connectum/auth: Gateway auth requires non-empty trustSource.expectedValues");
    }

    // Pre-compute headers to strip (prevents downstream spoofing on all routes)
    const headersToStrip = [
        headerMapping.subject,
        headerMapping.name,
        headerMapping.roles,
        headerMapping.scopes,
        headerMapping.type,
        headerMapping.claims,
        trustSource.header,
        ...stripHeaders,
    ];

    function stripGatewayHeaders(headers: Headers): void {
        for (const header of headersToStrip) {
            if (header) headers.delete(header);
        }
    }

    return (next) => async (req: UnaryRequest | StreamRequest) => {
        const serviceName: string = req.service.typeName;
        const methodName: string = req.method.name;

        if (matchesMethodPattern(serviceName, methodName, skipMethods)) {
            // Strip gateway headers even for skipped methods to prevent spoofing
            stripGatewayHeaders(req.header);
            return await next(req);
        }

        // Verify trust
        const trustHeaderValue = req.header.get(trustSource.header);
        if (!trustHeaderValue || !isTrusted(trustHeaderValue, trustSource.expectedValues)) {
            throw new ConnectError("Untrusted request source", Code.Unauthenticated);
        }

        // Extract subject (required)
        const subject = req.header.get(headerMapping.subject);
        if (!subject) {
            throw new ConnectError("Missing subject header from gateway", Code.Unauthenticated);
        }

        // Extract optional fields
        const name = headerMapping.name ? (req.header.get(headerMapping.name) ?? undefined) : undefined;
        const type = headerMapping.type ? (req.header.get(headerMapping.type) ?? defaultType) : defaultType;

        // Parse roles: JSON array or comma-separated
        let roles: string[] = [];
        if (headerMapping.roles) {
            const rolesRaw = req.header.get(headerMapping.roles);
            if (rolesRaw) {
                try {
                    const parsed: unknown = JSON.parse(rolesRaw);
                    if (Array.isArray(parsed)) {
                        roles = parsed.filter((r): r is string => typeof r === "string");
                    }
                } catch {
                    // Not JSON — try comma-separated
                    roles = rolesRaw
                        .split(",")
                        .map((r) => r.trim())
                        .filter(Boolean);
                }
            }
        }

        // Parse scopes: space-separated
        let scopes: string[] = [];
        if (headerMapping.scopes) {
            const scopesRaw = req.header.get(headerMapping.scopes);
            if (scopesRaw) {
                scopes = scopesRaw.split(" ").filter(Boolean);
            }
        }

        // Parse claims: JSON object
        let claims: Record<string, unknown> = {};
        if (headerMapping.claims) {
            const claimsRaw = req.header.get(headerMapping.claims);
            if (claimsRaw && claimsRaw.length <= 8192) {
                try {
                    const parsed: unknown = JSON.parse(claimsRaw);
                    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                        claims = parsed as Record<string, unknown>;
                    }
                } catch {
                    // Invalid JSON — ignore
                }
            }
        }

        const authContext: AuthContext = { subject, name, roles, scopes, claims, type };

        // Strip mapped headers to prevent downstream spoofing
        stripGatewayHeaders(req.header);

        if (propagateHeaders) {
            setAuthHeaders(req.header, authContext);
        }

        return await authContextStorage.run(authContext, () => next(req));
    };
}
