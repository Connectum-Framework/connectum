/**
 * Internal (service-to-service) authentication interceptor (ADR-029).
 *
 * For `internal` methods, authorizes the call from a configurable per-service
 * trust source rather than an end-user token, and rejects a missing/invalid
 * marker as `Code.Unauthenticated`. Non-internal methods pass through unchanged.
 *
 * Ships three trust-source factories:
 * - {@link meshIdentityTrust} — production default, per-service via the mesh.
 * - {@link signedTokenTrust} — non-mesh, per-service JWT/JWKS with mandatory
 *   issuer-bound key selection.
 * - {@link sharedSecretTrust} — dev-only fallback (single shared secret).
 *
 * Chain ordering is load-bearing: this interceptor runs BEFORE
 * `createProtoAuthzInterceptor` — it populates the `AuthContext` proto-authz
 * consumes (`errorHandler -> (jwtAuth | internalAuth) -> protoAuthz`).
 *
 * @module internal-auth-interceptor
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { Interceptor, StreamRequest, UnaryRequest } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import * as jose from "jose";
import { authContextStorage } from "./context.ts";
import { matchesMethodPattern } from "./method-match.ts";
import type {
    AuthContext,
    InternalAuthInterceptorOptions,
    InternalTrustSource,
    MeshIdentityTrustOptions,
    SharedSecretTrustOptions,
    SignedTokenIssuer,
    SignedTokenTrustOptions,
} from "./types.ts";

/**
 * Create an internal (service-to-service) authentication interceptor.
 *
 * For methods matched by `internalMethods`, the configured `trustSource`
 * authorizes the call and sets an `AuthContext`. A trust source returning
 * `null` (or throwing) is rejected as `Code.Unauthenticated`. Non-internal
 * methods are a no-op pass-through.
 *
 * MUST run BEFORE `createProtoAuthzInterceptor`: the internal interceptor
 * populates the `AuthContext` that proto-authz's `internal` rule consumes.
 *
 * Each trust-source factory strips its own trust header after extraction on the
 * internal path (accept and reject), to prevent a spoofed marker from being
 * propagated downstream. NOTE: for NON-internal methods this interceptor is a
 * pure pass-through and does NOT strip any trust headers — a request to a
 * `public`/gated method carrying a forged identity header passes through
 * untouched. In the supported deployments the mesh sidecar (or an upstream
 * gateway) terminates the trust boundary and scrubs these headers on every
 * route; do not rely on this interceptor to sanitize non-internal routes.
 *
 * @param options - Internal auth configuration.
 * @returns ConnectRPC interceptor.
 *
 * @example Mesh deployment (production default)
 * ```typescript
 * import { createInternalAuthInterceptor, meshIdentityTrust, getInternalMethods } from '@connectum/auth';
 *
 * const internalAuth = createInternalAuthInterceptor({
 *   internalMethods: getInternalMethods(services),
 *   trustSource: meshIdentityTrust({
 *     allowlist: [
 *       { principal: 'cluster.local/ns/default/sa/trips', roles: ['worker'] },
 *     ],
 *   }),
 * });
 * ```
 *
 * @example Non-mesh, per-service signed tokens
 * ```typescript
 * import { createInternalAuthInterceptor, signedTokenTrust, getInternalMethods } from '@connectum/auth';
 *
 * const internalAuth = createInternalAuthInterceptor({
 *   internalMethods: getInternalMethods(services),
 *   trustSource: signedTokenTrust({
 *     issuers: {
 *       'trips-service': { jwksUri: 'https://trips/.well-known/jwks.json', claimsMapping: { roles: 'roles' } },
 *       'billing-service': { jwksUri: 'https://billing/.well-known/jwks.json' },
 *     },
 *   }),
 * });
 * ```
 */
export function createInternalAuthInterceptor(options: InternalAuthInterceptorOptions): Interceptor {
    const { trustSource, internalMethods } = options;

    if (typeof trustSource !== "function") {
        throw new Error("@connectum/auth: createInternalAuthInterceptor requires a trustSource function");
    }

    return (next) => async (req: UnaryRequest | StreamRequest) => {
        const serviceName: string = req.service.typeName;
        const methodName: string = req.method.name;

        // Non-internal methods: no-op pass-through.
        if (!matchesMethodPattern(serviceName, methodName, internalMethods)) {
            return await next(req);
        }

        // Internal method: require a valid trust marker.
        // A null result OR any thrown error from the trust source maps to
        // Unauthenticated (never leak as Internal/Unknown).
        let authContext: AuthContext | null;
        try {
            authContext = await trustSource(req);
        } catch {
            authContext = null;
        }

        if (!authContext) {
            throw new ConnectError("Untrusted internal request", Code.Unauthenticated);
        }

        return await authContextStorage.run(authContext, () => next(req));
    };
}

// ---------------------------------------------------------------------------
// Trust source (a): mesh identity allow-list
// ---------------------------------------------------------------------------

/**
 * Trust source that verifies a mesh-forwarded peer identity against an
 * allow-list (ADR-029 option (a) — production default, inherently per-service).
 *
 * In a service mesh the sidecar terminates mTLS and forwards the verified peer
 * identity as a header (e.g. an Istio short-form ServiceAccount principal
 * `cluster.local/ns/<ns>/sa/<name>`, or a SPIFFE id). The mesh issues each
 * workload its OWN mTLS identity, so matching that forwarded principal against
 * an allow-list is per-service by construction — compromising one workload
 * cannot forge another's identity.
 *
 * The identity header is stripped after extraction to prevent downstream
 * spoofing.
 *
 * @param options - Allow-list and the identity header name.
 * @returns An {@link InternalTrustSource}.
 */
export function meshIdentityTrust(options: MeshIdentityTrustOptions): InternalTrustSource {
    const { allowlist, header = "x-forwarded-client-principal", type = "mesh" } = options;

    if (allowlist.length === 0) {
        throw new Error("@connectum/auth: meshIdentityTrust requires a non-empty allowlist");
    }

    // Index by principal for O(1) lookup.
    const byPrincipal = new Map(allowlist.map((entry) => [entry.principal, entry]));

    return (req) => {
        const principal = req.header.get(header);
        // Strip the identity header regardless of outcome (anti-spoofing).
        req.header.delete(header);

        if (!principal) {
            return null;
        }
        const entry = byPrincipal.get(principal);
        if (!entry) {
            return null;
        }

        const context: AuthContext = {
            subject: entry.principal,
            name: entry.name,
            roles: entry.roles ? [...entry.roles] : [],
            scopes: entry.scopes ? [...entry.scopes] : [],
            claims: { principal: entry.principal },
            type,
        };
        return context;
    };
}

// ---------------------------------------------------------------------------
// Trust source (b): per-service signed token (issuer-bound JWKS)
// ---------------------------------------------------------------------------

/** Resolve a value at a dot-notation path in an object. */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    let current: unknown = obj;
    for (const key of path.split(".")) {
        if (current === null || current === undefined || typeof current !== "object") {
            return undefined;
        }
        current = (current as Record<string, unknown>)[key];
    }
    return current;
}

/** Map verified token claims to roles/scopes/name per the issuer's claimsMapping. */
function mapTokenClaims(
    payload: jose.JWTPayload,
    mapping: NonNullable<SignedTokenIssuer["claimsMapping"]> | undefined,
): { name?: string; roles: string[]; scopes: string[]; subjectClaim?: string } {
    const claims = payload as Record<string, unknown>;
    const result: { name?: string; roles: string[]; scopes: string[]; subjectClaim?: string } = { roles: [], scopes: [] };
    if (!mapping) {
        // Default: scope claim (space-separated) if present.
        if (typeof payload.scope === "string") {
            result.scopes = payload.scope.split(" ").filter(Boolean);
        }
        return result;
    }

    if (mapping.subject) {
        const val = getNestedValue(claims, mapping.subject);
        if (typeof val === "string") result.subjectClaim = val;
    }
    if (mapping.name) {
        const val = getNestedValue(claims, mapping.name);
        if (typeof val === "string") result.name = val;
    }
    if (mapping.roles) {
        const val = getNestedValue(claims, mapping.roles);
        if (Array.isArray(val)) result.roles = val.filter((r): r is string => typeof r === "string");
    }
    if (mapping.scopes) {
        const val = getNestedValue(claims, mapping.scopes);
        if (typeof val === "string") result.scopes = val.split(" ").filter(Boolean);
        else if (Array.isArray(val)) result.scopes = val.filter((s): s is string => typeof s === "string");
    } else if (typeof payload.scope === "string") {
        result.scopes = payload.scope.split(" ").filter(Boolean);
    }

    return result;
}

/** Strip an optional `Bearer ` prefix from a header value. */
function stripBearer(value: string): string {
    const trimmed = value.trim();
    if (trimmed.toLowerCase().startsWith("bearer ")) {
        return trimmed.slice(7).trim();
    }
    return trimmed;
}

/**
 * Trust source that verifies a per-service signed JWT via issuer-bound JWKS
 * (ADR-029 option (b) — non-mesh per-service containment, NOT a shared secret).
 *
 * Each caller signs a short-lived JWT with its OWN private key; this trust
 * source verifies it against that service's published public key (JWKS).
 * Compromising service A's key forges only A.
 *
 * **Hard security requirement — issuer-bound key selection (verified
 * empirically with `jose`).** The keyset is selected by the token's claimed
 * `iss` (`issuers[iss].jwksUri`), and `jose.jwtVerify` is pinned to that same
 * `issuer`. Each issuer gets its OWN `createRemoteJWKSet` — no `jwtVerify` call
 * ever receives a keyset containing more than one issuer's keys. A single shared
 * JWKS holding multiple services' keys does NOT contain compromise: `jose`
 * resolves the signing key by `kid` independently of the `iss` claim, so a token
 * claiming `iss: "B"` signed with A's key (header `kid: kid_A`) would be accepted
 * against a shared keyset. This per-issuer binding prevents that forge.
 *
 * The framework ships only the verification primitive; key issuance/rotation/
 * JWKS publication belong to the deployment (SPIRE / the IdP / the mesh).
 *
 * @param options - Per-issuer JWKS configuration and the token header name.
 * @returns An {@link InternalTrustSource}.
 */
export function signedTokenTrust(options: SignedTokenTrustOptions): InternalTrustSource {
    const { issuers, header = "x-internal-token", type = "service" } = options;

    const issuerKeys = Object.keys(issuers);
    if (issuerKeys.length === 0) {
        throw new Error("@connectum/auth: signedTokenTrust requires at least one issuer");
    }

    // One JWKSet per issuer (issuer-bound). NEVER a shared keyset across issuers.
    const keysets = new Map<string, ReturnType<typeof jose.createRemoteJWKSet>>();
    for (const iss of issuerKeys) {
        const cfg = issuers[iss];
        if (!cfg) continue;
        keysets.set(iss, jose.createRemoteJWKSet(new URL(cfg.jwksUri)));
    }

    return async (req) => {
        const raw = req.header.get(header);
        // Strip the token header regardless of outcome (anti-spoofing).
        req.header.delete(header);

        if (!raw) {
            return null;
        }
        const token = stripBearer(raw);
        if (!token) {
            return null;
        }

        // Selection only: read the claimed issuer WITHOUT trusting it.
        let claimedIssuer: string | undefined;
        try {
            claimedIssuer = jose.decodeJwt(token).iss;
        } catch {
            return null;
        }
        if (typeof claimedIssuer !== "string") {
            return null;
        }

        const cfg = issuers[claimedIssuer];
        const keyset = keysets.get(claimedIssuer);
        if (!cfg || !keyset) {
            // Unknown / unconfigured issuer.
            return null;
        }

        // Verify against ONLY this issuer's keyset, pinned to this same issuer.
        // The `issuer` pin makes the iss claim load-bearing; the per-issuer
        // keyset makes the kid load-bearing within that one issuer only.
        const verifyOptions: jose.JWTVerifyOptions = {
            issuer: claimedIssuer,
            algorithms: cfg.algorithms ?? ["RS256"],
        };
        if (cfg.audience !== undefined) verifyOptions.audience = cfg.audience;
        if (cfg.maxTokenAge !== undefined) verifyOptions.maxTokenAge = cfg.maxTokenAge;

        let payload: jose.JWTPayload;
        try {
            ({ payload } = await jose.jwtVerify(token, keyset, verifyOptions));
        } catch {
            // Bad signature, no matching key, expired, wrong issuer, etc.
            return null;
        }

        const mapped = mapTokenClaims(payload, cfg.claimsMapping);
        // Subject from the VERIFIED payload: explicit subject claim, else sub, else iss.
        const subject = mapped.subjectClaim ?? payload.sub ?? claimedIssuer;

        const context: AuthContext = {
            subject,
            name: mapped.name,
            roles: mapped.roles,
            scopes: mapped.scopes,
            claims: payload as Record<string, unknown>,
            type,
            expiresAt: payload.exp ? new Date(payload.exp * 1000) : undefined,
        };
        return context;
    };
}

// ---------------------------------------------------------------------------
// Trust source (c): shared secret (DEV ONLY)
// ---------------------------------------------------------------------------

/**
 * Constant-time string comparison.
 *
 * `crypto.timingSafeEqual` throws on unequal-length buffers, which is itself a
 * length oracle. Comparing SHA-256 digests (always 32 bytes) removes that:
 * the digests are fixed-length and a mismatch is indistinguishable in time.
 */
function constantTimeEqual(a: string, b: string): boolean {
    const enc = new TextEncoder();
    // Hash to fixed length (32 bytes) so timingSafeEqual never sees unequal-length
    // inputs — comparing the raw strings would throw on a length mismatch, which
    // is itself a length oracle. SHA-256 digests are always equal length, so a
    // mismatch is indistinguishable in time.
    const da = createHash("sha256").update(enc.encode(a)).digest();
    const db = createHash("sha256").update(enc.encode(b)).digest();
    return timingSafeEqual(da, db);
}

/**
 * Trust source that constant-time compares a single shared secret (ADR-029
 * option (c)).
 *
 * **DEV-ONLY.** A single shared secret is NOT per-service: every legitimate
 * caller holds the same secret, so one compromise forges ALL internal
 * identities. Use {@link meshIdentityTrust} (mesh) or {@link signedTokenTrust}
 * (non-mesh per-service JWT) in production. This factory exists only for local
 * development and single-tenant low-trust-boundary setups, and is labeled as
 * such so it is never mistaken for a containment-providing mode.
 *
 * @param options - The shared secret, header name, and the granted identity.
 * @returns An {@link InternalTrustSource}.
 */
export function sharedSecretTrust(options: SharedSecretTrustOptions): InternalTrustSource {
    const { secret, header = "x-internal-secret", subject = "internal", roles, scopes, type = "internal" } = options;

    if (!secret) {
        throw new Error("@connectum/auth: sharedSecretTrust requires a non-empty secret");
    }

    return (req) => {
        const value = req.header.get(header);
        // Strip the secret header regardless of outcome (anti-spoofing).
        req.header.delete(header);

        if (!value || !constantTimeEqual(value, secret)) {
            return null;
        }

        const context: AuthContext = {
            subject,
            roles: roles ? [...roles] : [],
            scopes: scopes ? [...scopes] : [],
            claims: {},
            type,
        };
        return context;
    };
}
