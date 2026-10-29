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

import { createHash, timingSafeEqual } from "node:crypto";
import type { Interceptor, StreamRequest, UnaryRequest } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import { HEADER_BREAKING_CHARS, propagateAuthHeaders } from "./headers.ts";
import { assertNoCatchAllSkip, matchesMethodPattern } from "./method-match.ts";
import { runWithAuthContext } from "./run-with-auth-context.ts";
import type { AuthContext, GatewayAuthInterceptorOptions } from "./types.ts";
import { AUTH_HEADERS } from "./types.ts";

/** One decimal octet: `0` or 1-3 digits without a leading zero, so `010` and `1e1` are not octets. */
const OCTET = /^(?:0|[1-9]\d{0,2})$/;
/** A CIDR prefix length: one or two plain digits (the range is checked separately). */
const PREFIX = /^\d{1,2}$/;

/**
 * Parse a dotted-quad IPv4 address into an unsigned 32-bit integer, or `null`
 * when the text is anything else. Parsing is strict on purpose: `Number()` and
 * `parseInt()` accept empty parts, hex, exponents, signs and trailing junk, and
 * such a value must never be read as an address inside a trusted range.
 */
function parseIPv4(text: string): number | null {
    const parts = text.split(".");
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!OCTET.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        // Plain arithmetic (a double holds 32 bits exactly), so no signed
        // bit-shift can flip the high bit.
        value = value * 256 + octet;
    }
    return value;
}

/** The network and prefix length of a well-formed `a.b.c.d/prefix` block, or `null` for any other text. */
function parseCidrBlock(pattern: string): { network: number; prefix: number } | null {
    const slash = pattern.indexOf("/");
    if (slash === -1) return null;
    const prefixText = pattern.slice(slash + 1);
    if (!PREFIX.test(prefixText)) return null;
    const prefix = Number(prefixText);
    if (prefix > 32) return null;
    const network = parseIPv4(pattern.slice(0, slash));
    return network === null ? null : { network, prefix };
}

/**
 * Match an IPv4 address against a `a.b.c.d/prefix` block.
 *
 * A pattern that is not a well-formed CIDR block (for example `10.0.0.0/33`,
 * `10.0.0.0/abc`) matches nothing here and is left to the exact comparison in
 * {@link isTrusted}: `expectedValues` also carries shared secrets, which may
 * legitimately contain `/`, so a malformed block cannot be told apart from a
 * secret and must not widen trust.
 */
function matchesIp(address: string, pattern: string): boolean {
    const block = parseCidrBlock(pattern);
    const peer = parseIPv4(address);
    if (block === null || peer === null) return false;
    const { network, prefix } = block;
    // Two addresses share the first `prefix` bits exactly when they fall into
    // the same aligned block of 2^(32 - prefix) addresses.
    const blockSize = 2 ** (32 - prefix);
    return Math.floor(peer / blockSize) === Math.floor(network / blockSize);
}

function digest(text: string): Buffer {
    // utf16le keeps every code unit distinct; utf8 would map any lone surrogate to U+FFFD and make unequal texts equal.
    return createHash("sha256").update(text, "utf16le").digest();
}

/**
 * Check if a trust header value matches any of the expected values.
 *
 * For each expected value, tries exact match first, then CIDR match.
 *
 * The exact match is constant time: a shared secret is compared through fixed-size digests with
 * `timingSafeEqual`, so neither the position of the first differing byte nor the length of the
 * guess shows in the response time.
 */
function isTrusted(headerValue: string, expectedValues: readonly string[], allowCidr: boolean): boolean {
    const headerDigest = digest(headerValue);
    for (const expected of expectedValues) {
        if (timingSafeEqual(headerDigest, digest(expected))) return true;
        if (allowCidr && expected.includes("/") && matchesIp(headerValue, expected)) return true;
    }
    return false;
}

/**
 * Read the roles header sent by a trusted gateway.
 *
 * A value that parses as a JSON array yields its string items as sent (non-string items are
 * dropped, nothing is trimmed or split). Every other value, whether it is not JSON at all or is
 * JSON of another kind (`123`, `true`, `null`, a quoted string, an object), is a comma-separated
 * list: items are trimmed and empty items dropped. A role that is named like a JSON literal
 * therefore stays a role instead of vanishing.
 */
function parseRoles(raw: string): string[] {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
            return parsed.filter((r): r is string => typeof r === "string");
        }
    } catch {
        // Not JSON: read it as a comma-separated list below.
    }
    return raw
        .split(",")
        .map((r) => r.trim())
        .filter(Boolean);
}

/**
 * Create a gateway authentication interceptor.
 *
 * Reads pre-authenticated identity from gateway-injected headers.
 * Trust is established by checking a designated header value against
 * a list of expected values: shared secrets, compared exactly, and, only with
 * `trustSource.allowCallerControlledCidr`, IPv4 CIDR blocks applied to the header value.
 * A trusted gateway must overwrite this header; it is not the connection's peer address.
 *
 * Once the identity is read, the interceptor deletes every standard `x-auth-*` identity header
 * together with the mapped headers, the trust header and `stripHeaders` (also on `skipMethods`).
 * With `propagateHeaders` the verified identity is then written back, so an `x-auth-*` header seen
 * downstream always comes from the verified identity, never from the client.
 *
 * @param options - Gateway auth configuration
 * @returns ConnectRPC interceptor
 * @throws {Error} When `headerMapping.subject` or `trustSource.expectedValues` is missing, `skipMethods`
 *   contains `"*"`, `defaultType` contains NUL, CR or LF, or `trustSource.expectedValues` contains a CIDR block
 *   while `trustSource.allowCallerControlledCidr` is not `true`
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
    assertNoCatchAllSkip(skipMethods);
    // A CIDR block is matched against a header the caller itself chooses, so it proves nothing
    // about who the caller is. Refuse it unless the deployment asked for it by name.
    const allowCidr = trustSource.allowCallerControlledCidr === true;
    if (!allowCidr) {
        const block = trustSource.expectedValues.find((value) => parseCidrBlock(value) !== null);
        if (block !== undefined) {
            throw new Error(
                `@connectum/auth: Gateway auth trustSource.expectedValues contains the CIDR block "${block}". A block is matched against the value of the "${trustSource.header}" header, which a caller that reaches the service directly chooses itself, so it does not prove the request came through the gateway. Use a shared secret, or set trustSource.allowCallerControlledCidr: true only when a trusted upstream overwrites that header on every request and no client can reach the service without passing through it.`,
            );
        }
    }
    // defaultType becomes AuthContext.type of every request that sends no type header, and
    // is propagated as a header; a value that cannot be a header would fail every such request.
    if (HEADER_BREAKING_CHARS.test(defaultType)) {
        throw new Error("@connectum/auth: Gateway auth defaultType must not contain NUL, CR or LF characters, or characters above U+00FF");
    }

    // Pre-compute headers to strip (prevents downstream spoofing on all routes).
    // The standard identity headers are always included, whatever the mapping says: with
    // propagateHeaders only the fields the verified identity has are written back, so a
    // client-supplied value for an absent field (roles, scopes, name, claims) would
    // otherwise reach the next hop as if it were verified. Stripping happens after the
    // mapped input is read, because a gateway behind another gateway maps these very names.
    const headersToStrip = [
        ...Object.values(AUTH_HEADERS),
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
        if (!trustHeaderValue || !isTrusted(trustHeaderValue, trustSource.expectedValues, allowCidr)) {
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
                roles = parseRoles(rolesRaw);
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
            propagateAuthHeaders(req.header, authContext);
        }

        return await runWithAuthContext(authContext, () => next(req));
    };
}
