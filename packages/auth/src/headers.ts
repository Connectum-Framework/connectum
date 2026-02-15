/**
 * Auth header propagation utilities
 *
 * Handles serialization/deserialization of AuthContext to/from
 * HTTP headers for cross-service context propagation.
 *
 * @module headers
 */

import type { AuthContext } from "./types.ts";
import { AUTH_HEADERS } from "./types.ts";

/**
 * Sanitize a header value by removing control characters and enforcing length limits.
 */
function sanitizeHeaderValue(value: string, maxLength: number): string {
    // Remove control characters (except tab/LF/CR which are valid in headers)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char removal for header sanitization
    const cleaned = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    return cleaned.slice(0, maxLength);
}

/**
 * Serialize AuthContext to request headers.
 *
 * Sets standard auth headers on the provided Headers object.
 * Used by auth interceptors when propagateHeaders is enabled.
 *
 * @param headers - Headers object to set auth headers on
 * @param context - Auth context to serialize
 */
export function setAuthHeaders(headers: Headers, context: AuthContext): void {
    headers.set(AUTH_HEADERS.SUBJECT, context.subject);
    headers.set(AUTH_HEADERS.TYPE, context.type);

    if (context.roles.length > 0) {
        headers.set(AUTH_HEADERS.ROLES, JSON.stringify(context.roles));
    }

    if (context.scopes.length > 0) {
        headers.set(AUTH_HEADERS.SCOPES, context.scopes.join(" "));
    }

    const claimKeys = Object.keys(context.claims);
    if (claimKeys.length > 0) {
        headers.set(AUTH_HEADERS.CLAIMS, JSON.stringify(context.claims));
    }
}

/**
 * Parse AuthContext from request headers.
 *
 * Deserializes auth context from standard headers set by an upstream
 * service or gateway. Returns undefined if required headers are missing.
 *
 * WARNING: Only use this in trusted environments (behind mTLS, mesh, etc.).
 * For untrusted environments, use createTrustedHeadersReader() instead.
 *
 * @param headers - Request headers to parse
 * @returns Parsed AuthContext or undefined if headers are missing
 *
 * @example Trust upstream auth headers
 * ```typescript
 * import { parseAuthHeaders } from '@connectum/auth';
 *
 * const context = parseAuthHeaders(req.header);
 * if (context) {
 *   console.log(`Authenticated as ${context.subject}`);
 * }
 * ```
 */
export function parseAuthHeaders(headers: Headers): AuthContext | undefined {
    const subjectHeader = headers.get(AUTH_HEADERS.SUBJECT);
    if (!subjectHeader) {
        return undefined;
    }

    const subject = sanitizeHeaderValue(subjectHeader, 512);
    const typeHeader = headers.get(AUTH_HEADERS.TYPE);
    const type = typeHeader ? sanitizeHeaderValue(typeHeader, 128) : "unknown";
    const rolesRaw = headers.get(AUTH_HEADERS.ROLES);
    const scopesRaw = headers.get(AUTH_HEADERS.SCOPES);
    const claimsRaw = headers.get(AUTH_HEADERS.CLAIMS);

    let roles: string[] = [];
    if (rolesRaw) {
        try {
            const parsed: unknown = JSON.parse(rolesRaw);
            if (Array.isArray(parsed)) {
                roles = parsed.filter((r): r is string => typeof r === "string");
            }
        } catch {
            // Invalid JSON — ignore malformed header
        }
    }

    let scopes: string[] = [];
    if (scopesRaw) {
        scopes = scopesRaw.split(" ").filter(Boolean);
    }

    let claims: Record<string, unknown> = {};
    if (claimsRaw) {
        if (claimsRaw.length > 8192) {
            // Claims too large — ignore to prevent abuse
            claims = {};
        } else {
            try {
                const parsed: unknown = JSON.parse(claimsRaw);
                if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
                    claims = parsed as Record<string, unknown>;
                }
            } catch {
                // Invalid JSON — ignore malformed header
            }
        }
    }

    return {
        subject,
        type,
        roles,
        scopes,
        claims,
    };
}
