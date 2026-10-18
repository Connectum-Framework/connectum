/**
 * Header propagation safety: an identity that cannot be written into a header is rejected
 * before it is cached.
 *
 * With `propagateHeaders` on, a verified subject, type, name or scope holding NUL, CR or LF
 * ends the request with Unauthenticated, and the failed identity is never stored, so the
 * next request with the same credential verifies again. With propagation off the same
 * identity is admitted. The network block runs the whole path (HTTP/2 server, real client,
 * real JWT) because only a real transport shows what a caller actually receives.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { assertConnectError, createMockNext, createMockRequest } from "@connectum/testing";
import { jwtVerify } from "jose";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { getAuthContext } from "../../src/context.ts";
import { createGatewayAuthInterceptor } from "../../src/gateway-auth-interceptor.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import { createMockAuthContext } from "../../src/testing/mock-context.ts";
import { createTestJwt, TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import type { AuthContext } from "../../src/types.ts";
import { boot, buildRoutes, clientFor, createProbe } from "../helpers/stream-context.ts";

const UNSAFE: Array<[string, Partial<AuthContext>]> = [
    ["a subject with LF", { subject: "al\nice" }],
    ["a subject with CR", { subject: "al\rice" }],
    ["a subject with NUL", { subject: "al\0ice" }],
    ["a type with LF", { type: "api\nkey" }],
    ["a name with CR", { name: "Al\rice" }],
    ["a scope with LF", { scopes: ["read", "wri\nte"] }],
    ["a scope with NUL", { scopes: ["re\0ad"] }],
];

function headersWith(token: string): Headers {
    return new Headers({ authorization: `Bearer ${token}` });
}

describe("header propagation safety", () => {
    describe("createAuthInterceptor", () => {
        for (const [label, override] of UNSAFE) {
            it(`rejects ${label} as Unauthenticated, never caches it and never calls the handler`, async () => {
                let verifications = 0;
                const interceptor = createAuthInterceptor({
                    verifyCredentials: async () => {
                        verifications++;
                        return createMockAuthContext(override);
                    },
                    cache: { ttl: 60_000 },
                    propagateHeaders: true,
                });
                const next = createMockNext();
                const handler = interceptor(next);

                for (let attempt = 1; attempt <= 2; attempt++) {
                    const req = createMockRequest({ headers: headersWith("same-token") });
                    await assert.rejects(
                        () => handler(req),
                        (err: unknown) => {
                            assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                            return true;
                        },
                    );
                    assert.strictEqual(req.header.get("x-auth-subject"), null, "no partial identity header is left on the request");
                    assert.strictEqual(verifications, attempt, "the failed identity was not served from the cache");
                }
                assert.strictEqual(next.mock.calls.length, 0);
            });

            it(`admits ${label} when propagation is off`, async () => {
                const interceptor = createAuthInterceptor({ verifyCredentials: async () => createMockAuthContext(override), propagateHeaders: false });
                const next = createMockNext();

                await interceptor(next)(createMockRequest({ headers: headersWith("t") }));

                assert.strictEqual(next.mock.calls.length, 1);
            });
        }

        it("still caches and propagates a clean identity", async () => {
            let verifications = 0;
            const interceptor = createAuthInterceptor({
                verifyCredentials: async () => {
                    verifications++;
                    return createMockAuthContext({ subject: "alice" });
                },
                cache: { ttl: 60_000 },
                propagateHeaders: true,
            });
            const next = createMockNext();
            const handler = interceptor(next);

            const first = createMockRequest({ headers: headersWith("tok") });
            const second = createMockRequest({ headers: headersWith("tok") });
            await handler(first);
            await handler(second);

            assert.strictEqual(verifications, 1);
            assert.strictEqual(first.header.get("x-auth-subject"), "alice");
            assert.strictEqual(second.header.get("x-auth-subject"), "alice");
        });
    });

    describe("createSessionAuthInterceptor", () => {
        for (const [label, override] of UNSAFE) {
            it(`rejects ${label} as Unauthenticated and never caches it`, async () => {
                let verifications = 0;
                const interceptor = createSessionAuthInterceptor({
                    verifySession: async () => {
                        verifications++;
                        return {};
                    },
                    mapSession: async () => createMockAuthContext(override),
                    cache: { ttl: 60_000 },
                    propagateHeaders: true,
                });
                const next = createMockNext();
                const handler = interceptor(next);

                for (let attempt = 1; attempt <= 2; attempt++) {
                    await assert.rejects(
                        () => handler(createMockRequest({ headers: headersWith("sess") })),
                        (err: unknown) => {
                            assertConnectError(err, Code.Unauthenticated, "Authentication failed");
                            return true;
                        },
                    );
                    assert.strictEqual(verifications, attempt, "the failed identity was not served from the cache");
                }
                assert.strictEqual(next.mock.calls.length, 0);
            });
        }

        it("admits the same identity when propagation is off", async () => {
            const interceptor = createSessionAuthInterceptor({
                verifySession: async () => ({}),
                mapSession: async () => createMockAuthContext({ subject: "al\nice" }),
                propagateHeaders: false,
            });
            const next = createMockNext();

            await interceptor(next)(createMockRequest({ headers: headersWith("s") }));

            assert.strictEqual(next.mock.calls.length, 1);
        });
    });

    describe("createGatewayAuthInterceptor defaultType", () => {
        const base = { headerMapping: { subject: "x-user" }, trustSource: { header: "x-gateway", expectedValues: ["secret"] } };

        for (const [label, defaultType] of [
            ["LF", "gate\nway"],
            ["CR", "gate\rway"],
            ["NUL", "gate\0way"],
        ] as const) {
            it(`throws at creation for a defaultType with ${label}`, () => {
                assert.throws(
                    () => createGatewayAuthInterceptor({ ...base, defaultType }),
                    (err: unknown) => {
                        assert.ok(err instanceof Error);
                        assert.ok(err.message.includes("defaultType"), err.message);
                        assert.ok(err.message.includes("NUL, CR or LF"), err.message);
                        return true;
                    },
                );
            });
        }

        it("uses 'gateway' as the credential type when defaultType and the type header are absent", async () => {
            let seen: AuthContext | undefined;
            const interceptor = createGatewayAuthInterceptor(base);
            const next = mock.fn(async () => {
                seen = getAuthContext();
                return { message: {} };
            });
            const headers = new Headers({ "x-gateway": "secret", "x-user": "alice" });

            await interceptor(next as never)(createMockRequest({ headers }));

            assert.strictEqual(seen?.type, "gateway");
        });

        it("uses a configured defaultType and lets the type header override it", async () => {
            const seen: string[] = [];
            const interceptor = createGatewayAuthInterceptor({ ...base, headerMapping: { subject: "x-user", type: "x-type" }, defaultType: "edge" });
            const next = mock.fn(async () => {
                seen.push(getAuthContext()?.type ?? "none");
                return { message: {} };
            });
            const handler = interceptor(next as never);

            await handler(createMockRequest({ headers: new Headers({ "x-gateway": "secret", "x-user": "alice" }) }));
            await handler(createMockRequest({ headers: new Headers({ "x-gateway": "secret", "x-user": "alice", "x-type": "mtls" }) }));

            assert.deepStrictEqual(seen, ["edge", "mtls"]);
        });
    });

    describe("over the network (HTTP/2 server, real client, real JWT)", () => {
        /** A verifier that really checks the signature and counts how often it ran. */
        function countingJwtAuth(options: { propagateHeaders: boolean }) {
            const counter = { verifications: 0 };
            const key = new TextEncoder().encode(TEST_JWT_SECRET);
            const interceptor = createAuthInterceptor({
                verifyCredentials: async (token) => {
                    counter.verifications++;
                    const { payload } = await jwtVerify(token, key);
                    if (typeof payload.sub !== "string") {
                        throw new ConnectError("no subject", Code.Unauthenticated);
                    }
                    return { subject: payload.sub, roles: [], scopes: [], claims: payload, type: "jwt" };
                },
                cache: { ttl: 60_000 },
                propagateHeaders: options.propagateHeaders,
            });
            return { interceptor, counter };
        }

        async function echo(client: ReturnType<typeof clientFor>, token: string) {
            return await client.echo({ value: "ping", sequence: 7 }, { headers: { authorization: `Bearer ${token}` } });
        }

        it("answers a token whose sub holds a line break with Unauthenticated and verifies it again on every request", async () => {
            const { interceptor, counter } = countingJwtAuth({ propagateHeaders: true });
            const probe = createProbe();
            const server = await boot({ interceptors: [interceptor], routes: buildRoutes(probe) });
            try {
                const client = clientFor(server, "http");
                const token = await createTestJwt({ sub: "al\nice" }, { expiresIn: "5m" });

                for (const expectedVerifications of [1, 2]) {
                    await assert.rejects(
                        () => echo(client, token),
                        (err: unknown) => {
                            assertConnectError(err, Code.Unauthenticated);
                            return true;
                        },
                    );
                    assert.strictEqual(counter.verifications, expectedVerifications, "verification ran again: the rejected identity was not cached");
                }
                assert.deepStrictEqual(
                    probe.observations.filter((o) => o.phase === "unary-start"),
                    [],
                    "the handler never ran",
                );
            } finally {
                await server.stop();
            }
        });

        it("admits the same token when propagation is off", async () => {
            const { interceptor } = countingJwtAuth({ propagateHeaders: false });
            const probe = createProbe();
            const server = await boot({ interceptors: [interceptor], routes: buildRoutes(probe) });
            try {
                const client = clientFor(server, "http");
                const token = await createTestJwt({ sub: "al\nice" }, { expiresIn: "5m" });

                const reply = await echo(client, token);

                assert.strictEqual(reply.value, "ping");
                assert.strictEqual(reply.sequence, 7);
                assert.strictEqual(probe.observations.find((o) => o.phase === "unary-start")?.seen, "al\nice", "the handler ran as the line-break subject");
            } finally {
                await server.stop();
            }
        });

        it("admits and caches a token with a clean subject while propagation is on", async () => {
            const { interceptor, counter } = countingJwtAuth({ propagateHeaders: true });
            const server = await boot({ interceptors: [interceptor], routes: buildRoutes(createProbe()) });
            try {
                const client = clientFor(server, "http");
                const token = await createTestJwt({ sub: "alice" }, { expiresIn: "5m" });

                await echo(client, token);
                await echo(client, token);

                assert.strictEqual(counter.verifications, 1, "a clean identity is served from the cache on the second request");
            } finally {
                await server.stop();
            }
        });
    });
});
