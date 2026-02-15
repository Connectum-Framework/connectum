/**
 * Trusted headers reader
 *
 * Reads auth context from request headers ONLY when the request
 * originates from a trusted proxy. Fail-closed by default.
 *
 * @module trusted-headers
 */

import { parseAuthHeaders } from "./headers.ts";
import type { AuthContext, TrustedHeadersReaderOptions } from "./types.ts";

/**
 * Check if an IP address matches a CIDR range or exact IP.
 *
 * Supports:
 * - Exact match: "10.0.0.1"
 * - CIDR: "10.0.0.0/8"
 * - IPv6 exact match (basic)
 */
function matchesIp(peerAddress: string, pattern: string): boolean {
    // Exact match
    if (peerAddress === pattern) {
        return true;
    }

    // CIDR match
    if (pattern.includes("/")) {
        const [network, prefixStr] = pattern.split("/");
        if (!network || !prefixStr) {
            return false;
        }
        const prefix = Number.parseInt(prefixStr, 10);
        if (Number.isNaN(prefix)) {
            return false;
        }

        // Simple IPv4 CIDR matching
        const peerParts = peerAddress.split(".").map(Number);
        const networkParts = network.split(".").map(Number);

        if (peerParts.length !== 4 || networkParts.length !== 4) {
            return false;
        }

        // Convert to 32-bit integers
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
 * Create a trusted headers reader.
 *
 * Reads auth context from request headers ONLY when the request
 * comes from a trusted proxy (verified by IP/CIDR).
 *
 * FAIL-CLOSED: If trustedProxies is empty or the peer address
 * doesn't match, returns null (never trusts headers).
 *
 * @param options - Trusted headers reader options
 * @returns Function that reads auth context from trusted headers
 *
 * @example Behind Envoy/Istio
 * ```typescript
 * import { createTrustedHeadersReader, createAuthInterceptor } from '@connectum/auth';
 *
 * const readTrustedHeaders = createTrustedHeadersReader({
 *   trustedProxies: ['10.0.0.0/8', '172.16.0.0/12'],
 * });
 *
 * const auth = createAuthInterceptor({
 *   extractCredentials: (req) => {
 *     // Try trusted headers first (from mesh)
 *     const trusted = readTrustedHeaders(req);
 *     if (trusted) return 'trusted';
 *     // Fall back to Bearer token
 *     return req.header.get('authorization')?.replace(/^Bearer\s+/i, '') ?? null;
 *   },
 *   verifyCredentials: async (cred) => {
 *     if (cred === 'trusted') return readTrustedHeaders(req)!;
 *     return verifyJwt(cred);
 *   },
 * });
 * ```
 */
export function createTrustedHeadersReader(options: TrustedHeadersReaderOptions): (req: { header: Headers; peerAddress?: string }) => AuthContext | null {
    const { trustedProxies } = options;

    // Fail-closed: no proxies = never trust
    if (trustedProxies.length === 0) {
        return () => null;
    }

    return (req: { header: Headers; peerAddress?: string }): AuthContext | null => {
        const peerAddress = req.peerAddress;
        if (!peerAddress) {
            return null;
        }

        // Check if peer is a trusted proxy
        const isTrusted = trustedProxies.some((pattern) => matchesIp(peerAddress, pattern));
        if (!isTrusted) {
            return null;
        }

        // Parse auth context from headers
        return parseAuthHeaders(req.header) ?? null;
    };
}
