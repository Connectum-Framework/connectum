/**
 * Auth header propagation utilities
 *
 * Handles serialization/deserialization of AuthContext to/from
 * HTTP headers for cross-service context propagation.
 *
 * @module headers
 */

import { Code, ConnectError } from "@connectrpc/connect";
import type { AuthContext } from "./types.ts";
import { AUTH_HEADERS } from "./types.ts";

/** Maximum byte length for a single header value (shared with client interceptors). */
export const MAX_HEADER_BYTES = 8192;

/**
 * Sanitize a header value by removing control characters and enforcing length limits.
 *
 * Tab, LF and CR are kept by this function itself; on the write path
 * ({@link setAuthHeaders}) LF, CR and NUL never get here because an identity holding
 * one of them is refused first.
 */
export function sanitizeHeaderValue(value: string, maxLength: number): string {
    // Remove control characters (except tab/LF/CR which are valid in headers)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional control char removal for header sanitization
    const cleaned = value.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
    return cleaned.slice(0, maxLength);
}

/**
 * Thrown by {@link setAuthHeaders} when an identity field holds NUL, CR or LF and so
 * cannot be written into a header. `field` names the offending `AuthContext` field.
 */
export class UnsafeHeaderValueError extends TypeError {
    readonly field: "subject" | "type" | "name" | "scopes";

    constructor(field: UnsafeHeaderValueError["field"]) {
        super(`AuthContext.${field} must not contain NUL, CR or LF characters when auth headers are propagated`);
        this.name = "UnsafeHeaderValueError";
        this.field = field;
    }
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL, CR and LF are exactly the characters being detected
export const HEADER_BREAKING_CHARS = /[\x00\r\n]/;

/**
 * Find the first identity field that cannot be written into a header.
 *
 * NUL, CR and LF are rejected rather than stripped: removing a line break would turn
 * two different subjects (`al\nice` and `alice`) into the same header value, merging
 * their identities downstream. Scopes are checked one by one and are otherwise left
 * exactly as granted, because an edited scope could match a privilege nobody granted.
 */
function findUnsafeField(context: AuthContext): UnsafeHeaderValueError["field"] | undefined {
    if (HEADER_BREAKING_CHARS.test(context.subject)) return "subject";
    if (HEADER_BREAKING_CHARS.test(context.type)) return "type";
    if (context.name && HEADER_BREAKING_CHARS.test(context.name)) return "name";
    if (context.scopes.some((scope) => HEADER_BREAKING_CHARS.test(scope))) return "scopes";
    return undefined;
}

/**
 * Write an identity into request headers for downstream services, or reject the call.
 *
 * Interceptors use this instead of {@link setAuthHeaders} so that an identity which cannot
 * be propagated ends the request with `Code.Unauthenticated` (and is never cached) instead
 * of surfacing as an internal error. Every other failure of {@link setAuthHeaders} is rethrown as is.
 *
 * @param headers - Headers object to set auth headers on
 * @param context - Auth context to serialize
 * @param propagatedClaims - Optional list of claim keys to propagate (all if undefined)
 * @throws {ConnectError} `Code.Unauthenticated` when the identity holds NUL, CR or LF
 */
export function propagateAuthHeaders(headers: Headers, context: AuthContext, propagatedClaims?: string[]): void {
    try {
        setAuthHeaders(headers, context, propagatedClaims);
    } catch (err) {
        if (err instanceof UnsafeHeaderValueError) {
            throw new ConnectError("Authentication failed", Code.Unauthenticated, undefined, undefined, err);
        }
        throw err;
    }
}

/**
 * Serialize AuthContext to request headers.
 *
 * Sets standard auth headers on the provided Headers object.
 * Used by auth interceptors when propagateHeaders is enabled.
 *
 * `subject`, `type`, `name` are stripped of control characters (tab is kept) and truncated;
 * roles and claims are JSON; scopes are written as granted. A `subject`, `type`, `name` or
 * scope containing NUL, CR or LF is not sanitised but refused.
 *
 * @param headers - Headers object to set auth headers on
 * @param context - Auth context to serialize
 * @param propagatedClaims - Optional list of claim keys to propagate (all if undefined)
 * @throws {TypeError} When `subject`, `type`, `name` or a scope contains NUL, CR or LF; the message
 *   names the field and no header has been set
 */
export function setAuthHeaders(headers: Headers, context: AuthContext, propagatedClaims?: string[]): void {
    const unsafeField = findUnsafeField(context);
    if (unsafeField) {
        throw new UnsafeHeaderValueError(unsafeField);
    }

    headers.set(AUTH_HEADERS.SUBJECT, sanitizeHeaderValue(context.subject, 512));
    headers.set(AUTH_HEADERS.TYPE, sanitizeHeaderValue(context.type, 128));

    if (context.name) {
        headers.set(AUTH_HEADERS.NAME, sanitizeHeaderValue(context.name, 256));
    }

    if (context.roles.length > 0) {
        const rolesValue = JSON.stringify(context.roles);
        if (rolesValue.length <= MAX_HEADER_BYTES) {
            headers.set(AUTH_HEADERS.ROLES, rolesValue);
        }
    }

    if (context.scopes.length > 0) {
        const scopesValue = context.scopes.join(" ");
        if (scopesValue.length <= MAX_HEADER_BYTES) {
            headers.set(AUTH_HEADERS.SCOPES, scopesValue);
        }
    }

    const claimKeys = Object.keys(context.claims);
    if (claimKeys.length > 0) {
        const filteredClaims = propagatedClaims ? Object.fromEntries(Object.entries(context.claims).filter(([key]) => propagatedClaims.includes(key))) : context.claims;
        if (Object.keys(filteredClaims).length > 0) {
            const claimsValue = JSON.stringify(filteredClaims);
            if (claimsValue.length <= MAX_HEADER_BYTES) {
                headers.set(AUTH_HEADERS.CLAIMS, claimsValue);
            }
        }
    }
}

/**
 * Parse AuthContext from request headers.
 *
 * Deserializes auth context from standard headers set by an upstream
 * service or gateway. Returns undefined if required headers are missing.
 *
 * WARNING: Only use this in trusted environments (behind mTLS, mesh, etc.).
 * For gateway requests, use createGatewayAuthInterceptor() with a verified trust header.
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
    if (rolesRaw && rolesRaw.length <= MAX_HEADER_BYTES) {
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
    if (scopesRaw && scopesRaw.length <= MAX_HEADER_BYTES) {
        scopes = scopesRaw.split(" ").filter(Boolean);
    }

    const nameRaw = headers.get(AUTH_HEADERS.NAME);
    const name = nameRaw ? sanitizeHeaderValue(nameRaw, 256) : undefined;

    let claims: Record<string, unknown> = {};
    if (claimsRaw) {
        if (claimsRaw.length > MAX_HEADER_BYTES) {
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
        name,
        type,
        roles,
        scopes,
        claims,
    };
}
