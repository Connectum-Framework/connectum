/**
 * An identity without a usable subject, on every path that accepts one.
 *
 * The header path (the writer, `parseAuthHeaders`, the gateway reading a standard `x-auth-*`
 * subject) decides emptiness after the control characters are removed. An interceptor that takes
 * an identity from a verifier, a mapping function, a token, a trust source or a header must reach
 * the same verdict: a subject that is empty after the control characters that
 * `sanitizeHeaderValue` removes are removed is no subject, and a caller that treats "a context
 * was returned" as "the caller is authenticated" must never be handed one. The subject itself is
 * not rewritten: `a\x01b` stays `a\x01b` in the context, and a subject of spaces or tabs is
 * usable, because those are not characters the cleaning removes.
 *
 * Creation-time options that fix the subject or the type of every identity are refused when they
 * cannot produce a usable one, naming the option, in the style of the other option checks.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import type { Interceptor } from "@connectrpc/connect";
import { Code } from "@connectrpc/connect";
import { assertConnectError, createMockRequest } from "@connectum/testing";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { createClientGatewayInterceptor } from "../../src/client-gateway-interceptor.ts";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { createInternalAuthInterceptor, meshIdentityTrust, sharedSecretTrust, signedTokenTrust } from "../../src/internal-auth-interceptor.ts";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import { createTestJwtRS256, generateRsaTestKeypair, type RsaTestKeypair, startTestJwksServer, type TestJwksServer } from "../../src/testing/test-jwt-rs256.ts";
import type { AuthContext } from "../../src/types.ts";

/** Subjects that hold no character after the cleaning: one control character, several, DEL only. */
const UNUSABLE = ["", "\x01", "\x01\x0E\x7F"];
/** Propagation does not decide whether an identity is usable: both settings are covered. */
const PROPAGATION = [false, true] as const;

const REQUEST = { service: "test.Service", method: "Method" } as const;

/** An identity with a plain everything-else, so only the subject can make it unusable. */
function identity(subject: string, type = "jwt"): AuthContext {
    return { subject, type, roles: [], scopes: [], claims: {} };
}

interface CallResult {
    ran: boolean;
    seen?: AuthContext | undefined;
    error?: unknown;
}

/** Run an interceptor over a request; report whether the handler ran and what it saw. */
async function call(interceptor: Interceptor, req = createMockRequest(REQUEST)): Promise<CallResult> {
    let ran = false;
    let seen: AuthContext | undefined;
    const next = (async () => {
        ran = true;
        seen = getAuthContext();
        return { message: {} };
    }) as never;
    try {
        await interceptor(next)(req);
        return { ran, seen };
    } catch (error) {
        return { ran, error };
    }
}

/** The call ended with `Unauthenticated` and the interceptor's own text, and the handler did not run. */
function assertRefused(result: CallResult, message: string): void {
    assert.strictEqual(result.ran, false, "the handler must not run");
    assertConnectError(result.error, Code.Unauthenticated, message);
}

/** A request carrying a bearer token, the credential the generic, JWT and session interceptors read. */
function bearer(token = "token"): ReturnType<typeof createMockRequest> {
    const req = createMockRequest(REQUEST);
    req.header.set("authorization", `Bearer ${token}`);
    return req;
}

describe("createAuthInterceptor", () => {
    for (const propagateHeaders of PROPAGATION) {
        for (const subject of UNUSABLE) {
            const label = JSON.stringify(subject);
            it(`refuses a verifier subject ${label} (propagateHeaders: ${propagateHeaders})`, async () => {
                const interceptor = createAuthInterceptor({ verifyCredentials: async () => identity(subject), propagateHeaders });

                const result = await call(interceptor, bearer());

                assertRefused(result, "Authentication failed");
            });
        }

        it(`passes the subject a\\x01b and "   " through unchanged (propagateHeaders: ${propagateHeaders})`, async () => {
            for (const subject of ["a\x01b", "   ", "\t"]) {
                const interceptor = createAuthInterceptor({ verifyCredentials: async () => identity(subject), propagateHeaders });
                const result = await call(interceptor, bearer());
                assert.strictEqual(result.seen?.subject, subject, `the context keeps the subject ${JSON.stringify(subject)} as the verifier gave it`);
            }
        });
    }
});

describe("createJwtAuthInterceptor", () => {
    for (const propagateHeaders of PROPAGATION) {
        for (const subject of UNUSABLE) {
            const label = JSON.stringify(subject);
            it(`refuses a token whose sub is ${label} (propagateHeaders: ${propagateHeaders})`, async () => {
                const token = await createTestJwt({ sub: subject });
                const interceptor = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, propagateHeaders });

                const result = await call(interceptor, bearer(token));

                assertRefused(result, "JWT missing subject claim");
            });
        }

        it(`accepts a token whose sub holds a control character among other characters (propagateHeaders: ${propagateHeaders})`, async () => {
            const token = await createTestJwt({ sub: "a\x01b" });
            const interceptor = createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, propagateHeaders });

            const result = await call(interceptor, bearer(token));

            assert.strictEqual(result.seen?.subject, "a\x01b");
        });
    }
});

describe("createSessionAuthInterceptor", () => {
    for (const propagateHeaders of PROPAGATION) {
        for (const subject of UNUSABLE) {
            const label = JSON.stringify(subject);
            it(`refuses a mapped subject ${label} (propagateHeaders: ${propagateHeaders})`, async () => {
                const interceptor = createSessionAuthInterceptor({
                    verifySession: async () => ({}),
                    mapSession: () => identity(subject),
                    propagateHeaders,
                });

                const result = await call(interceptor, bearer());

                assertRefused(result, "Session mapping failed");
            });
        }
    }
});

describe("createInternalAuthInterceptor", () => {
    const SERVICE = "trips.v1.TripService";
    const PATTERN = `${SERVICE}/*`;
    const internal = () => createMockRequest({ service: SERVICE, method: "RecordTrip" });

    function internalInterceptor(trustSource: Parameters<typeof createInternalAuthInterceptor>[0]["trustSource"]) {
        return createInternalAuthInterceptor({ internalMethods: [PATTERN], trustSource });
    }

    for (const subject of UNUSABLE) {
        const label = JSON.stringify(subject);
        it(`refuses a trust source that returns subject ${label}`, async () => {
            const result = await call(internalInterceptor(() => identity(subject)), internal());
            assertRefused(result, "Untrusted internal request");
        });
    }

    it("passes the subject a\\x01b through unchanged", async () => {
        const result = await call(internalInterceptor(() => identity("a\x01b")), internal());
        assert.strictEqual(result.seen?.subject, "a\x01b");
    });
});

describe("sharedSecretTrust", () => {
    const SECRET = "s3cr3t-value-32-bytes-minimum-xx";

    for (const subject of UNUSABLE) {
        it(`refuses the subject ${JSON.stringify(subject)} at creation, naming the option`, () => {
            assert.throws(
                () => sharedSecretTrust({ secret: SECRET, subject }),
                new TypeError(
                    `@connectum/auth: sharedSecretTrust subject must hold a character after the control characters are removed; it is the subject of every identity`,
                ),
            );
        });
    }

    for (const type of UNUSABLE) {
        it(`refuses the type ${JSON.stringify(type)} at creation, naming the option`, () => {
            assert.throws(
                () => sharedSecretTrust({ secret: SECRET, type }),
                new TypeError(`@connectum/auth: sharedSecretTrust type must hold a character after the control characters are removed; it is the type of every identity`),
            );
        });
    }

    it("accepts a usable subject and type, and produces that identity", async () => {
        const trust = sharedSecretTrust({ secret: SECRET, subject: "worker", type: "batch" });
        const req = createMockRequest(REQUEST);
        req.header.set("x-internal-secret", SECRET);

        const context = await trust(req);

        assert.strictEqual(context?.subject, "worker");
        assert.strictEqual(context?.type, "batch");
    });
});

describe("meshIdentityTrust", () => {
    for (const principal of UNUSABLE) {
        it(`refuses the allowlist principal ${JSON.stringify(principal)} at creation, naming the entry`, () => {
            assert.throws(
                () => meshIdentityTrust({ allowlist: [{ principal }] }),
                new TypeError(
                    `@connectum/auth: meshIdentityTrust allowlist[0].principal must hold a character after the control characters are removed; it is the subject of every identity`,
                ),
            );
        });
    }

    for (const type of UNUSABLE) {
        it(`refuses the type ${JSON.stringify(type)} at creation, naming the option`, () => {
            assert.throws(
                () => meshIdentityTrust({ allowlist: [{ principal: "p" }], type }),
                new TypeError(`@connectum/auth: meshIdentityTrust type must hold a character after the control characters are removed; it is the type of every identity`),
            );
        });
    }
});

describe("signedTokenTrust", () => {
    const JWKS = "http://127.0.0.1:1/.well-known/jwks.json";

    for (const type of UNUSABLE) {
        it(`refuses the type ${JSON.stringify(type)} at creation, naming the option`, () => {
            assert.throws(
                () => signedTokenTrust({ issuers: { "service-a": { jwksUri: JWKS } }, type }),
                new TypeError(`@connectum/auth: signedTokenTrust type must hold a character after the control characters are removed; it is the type of every identity`),
            );
        });
    }

    for (const issuer of UNUSABLE) {
        it(`refuses issuer key ${JSON.stringify(issuer)} at creation when it is the subject, naming the entry`, () => {
            assert.throws(
                () => signedTokenTrust({ issuers: { [issuer]: { jwksUri: JWKS } } }),
                new TypeError(
                    `@connectum/auth: signedTokenTrust issuers[${JSON.stringify(issuer)}] must hold a character after the control characters are removed; it is the subject of every identity`,
                ),
            );
        });

        it(`accepts issuer key ${JSON.stringify(issuer)} when a claim supplies the subject`, () => {
            assert.doesNotThrow(() => signedTokenTrust({ issuers: { [issuer]: { jwksUri: JWKS, claimsMapping: { subject: "sub" } } } }));
        });
    }

    describe("a mapped subject from a verified token", () => {
        const ISSUER = "service-a";
        let keypair: RsaTestKeypair;
        let jwks: TestJwksServer;

        before(async () => {
            keypair = await generateRsaTestKeypair();
            jwks = await startTestJwksServer(keypair.publicJwk);
        });

        after(async () => {
            await jwks.close();
        });

        function interceptorForMappedSubject() {
            return createInternalAuthInterceptor({
                internalMethods: ["trips.v1.TripService/*"],
                trustSource: signedTokenTrust({ issuers: { [ISSUER]: { jwksUri: jwks.url, claimsMapping: { subject: "sub" } } } }),
            });
        }

        for (const subject of UNUSABLE) {
            const label = JSON.stringify(subject);
            it(`refuses a token whose mapped subject is ${label}`, async () => {
                const token = await createTestJwtRS256(keypair.privateKey, { sub: subject }, { kid: keypair.kid, issuer: ISSUER });
                const req = createMockRequest({ service: "trips.v1.TripService", method: "RecordTrip" });
                req.header.set("x-internal-token", token);

                const result = await call(interceptorForMappedSubject(), req);

                assertRefused(result, "Untrusted internal request");
            });
        }

        it("accepts a token whose mapped subject is usable", async () => {
            const token = await createTestJwtRS256(keypair.privateKey, { sub: "worker" }, { kid: keypair.kid, issuer: ISSUER });
            const req = createMockRequest({ service: "trips.v1.TripService", method: "RecordTrip" });
            req.header.set("x-internal-token", token);

            const result = await call(interceptorForMappedSubject(), req);

            assert.strictEqual(result.seen?.subject, "worker");
        });
    });
});

describe("createGatewayAuthInterceptor with a custom subject header", () => {
    function gateway(propagateHeaders: boolean) {
        return createGatewayAuthInterceptor({
            headerMapping: { subject: "x-user" },
            trustSource: { header: "x-gateway-secret", expectedValues: ["s"] },
            propagateHeaders,
        });
    }

    function request(header: string, subject: string): ReturnType<typeof createMockRequest> {
        const req = createMockRequest(REQUEST);
        req.header.set("x-gateway-secret", "s");
        req.header.set(header, subject);
        return req;
    }

    for (const propagateHeaders of PROPAGATION) {
        for (const subject of UNUSABLE) {
            const label = JSON.stringify(subject);
            it(`refuses a custom subject header of ${label}, as for a standard name (propagateHeaders: ${propagateHeaders})`, async () => {
                const result = await call(gateway(propagateHeaders), request("x-user", subject));

                assertRefused(result, "Missing subject header from gateway");
            });
        }

        it(`passes a custom subject of a\\x01b through unchanged (propagateHeaders: ${propagateHeaders})`, async () => {
            const result = await call(gateway(propagateHeaders), request("x-user", "a\x01b"));

            assert.strictEqual(result.seen?.subject, "a\x01b");
        });
    }
});

describe("createGatewayAuthInterceptor and an empty type header", () => {
    const HEADERS: Array<[string, string]> = [
        ["the standard name", "x-auth-type"],
        ["a custom name", "x-type"],
    ];

    for (const [label, typeHeader] of HEADERS) {
        for (const type of ["", "\x01", "\x01\x0E\x7F"]) {
            const typeLabel = JSON.stringify(type);
            it(`uses the default type when ${label} holds ${typeLabel}`, async () => {
                const interceptor = createGatewayAuthInterceptor({
                    headerMapping: { subject: "x-user", type: typeHeader },
                    trustSource: { header: "x-gateway-secret", expectedValues: ["s"] },
                    defaultType: "edge",
                });
                const req = createMockRequest(REQUEST);
                req.header.set("x-gateway-secret", "s");
                req.header.set("x-user", "s");
                req.header.set(typeHeader, type);

                const result = await call(interceptor, req);

                assert.strictEqual(result.seen?.type, "edge");
            });
        }

        it(`keeps a type header with other characters (${label})`, async () => {
            const interceptor = createGatewayAuthInterceptor({
                headerMapping: { subject: "x-user", type: typeHeader },
                trustSource: { header: "x-gateway-secret", expectedValues: ["s"] },
                defaultType: "edge",
            });
            const req = createMockRequest(REQUEST);
            req.header.set("x-gateway-secret", "s");
            req.header.set("x-user", "s");
            req.header.set(typeHeader, "jwt\x01");

            const result = await call(interceptor, req);

            // A standard text is read as the writer writes it (cleaned); a custom header is as sent.
            assert.strictEqual(result.seen?.type, typeHeader === "x-auth-type" ? "jwt" : "jwt\x01");
        });
    }
});

describe("createClientGatewayInterceptor", () => {
    it("refuses a control-only subject at creation through the writer, naming subject", () => {
        assert.throws(
            () => createClientGatewayInterceptor({ secret: "s", subject: "\x01" }),
            (err: unknown) => err instanceof TypeError && /createClientGatewayInterceptor subject/.test(err.message) && /must not be empty/.test(err.message),
        );
    });
});
