/**
 * The fallback interceptor and a refused call.
 *
 * A fallback value stands in for a failed dependency. It must never stand in for a refusal of
 * access: whatever the position of the authentication or authorization interceptor relative to
 * the fallback interceptor in the chain, a caller who is not allowed gets the refusal, and the
 * fallback handler is not asked for a value. Failures that are not refusals keep using it.
 *
 * Real `createServer` on h2c port 0, a real service, the real auth and authz interceptors from
 * `@connectum/auth`, a real Connect client.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Interceptor } from "@connectrpc/connect";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { createAuthInterceptor } from "../../../auth/src/auth-interceptor.ts";
import { createAuthzInterceptor } from "../../../auth/src/authz-interceptor.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../../../testing/tests/fixtures/echo/v1/echo_pb.ts";
import { createDefaultInterceptors } from "../../src/defaults.ts";

const FALLBACK_MESSAGE = "FALLBACK-VALUE";
const REAL_MESSAGE = "REAL-RESPONSE";
const VALID_TOKEN = "valid-token";

interface Probe {
    handlerCalls: number;
    fallbackCodes: Array<Code | undefined>;
}

function authInterceptor(): Interceptor {
    return createAuthInterceptor({
        verifyCredentials: (token) => {
            if (token !== VALID_TOKEN) {
                throw new Error("bad token");
            }
            return { subject: "alice", roles: ["user"], scopes: [], claims: {}, type: "test" };
        },
    });
}

/** A valid caller whose role is not admin: authentication passes, authorization refuses. */
function authzInterceptor(): Interceptor {
    return createAuthzInterceptor({
        defaultPolicy: "deny",
        rules: [{ name: "admin-only", methods: ["*"], requires: { roles: ["admin"] }, effect: "allow" }],
    });
}

function fallbackChain(probe: Probe): Interceptor[] {
    return createDefaultInterceptors({
        errorHandler: false,
        fallback: {
            handler: (err) => {
                probe.fallbackCodes.push(err instanceof ConnectError ? err.code : undefined);
                return create(EchoResponseSchema, { message: FALLBACK_MESSAGE });
            },
        },
    });
}

interface Outcome {
    code: string;
    message: string | null;
    handlerCalls: number;
    fallbackCodes: Array<string | undefined>;
}

/** Call `echo` once through a server with `interceptors`; `failWith` makes the service handler throw it. */
async function call(interceptors: (probe: Probe) => Interceptor[], token: string | null, failWith?: Error): Promise<Outcome> {
    const probe: Probe = { handlerCalls: 0, fallbackCodes: [] };
    const service = defineService(EchoService, {
        echo: () => {
            probe.handlerCalls += 1;
            if (failWith) {
                throw failWith;
            }
            return { message: REAL_MESSAGE };
        },
        secureEcho: () => ({ message: "unused" }),
        rateLimitedEcho: () => ({ message: "unused" }),
    });
    const server: Server = createServer({ services: [service], interceptors: interceptors(probe), port: 0, allowHTTP1: false });
    await server.start();
    try {
        const port = server.address?.port;
        assert.ok(port, "server must bind a port");
        const transport = createConnectTransport({
            baseUrl: `http://localhost:${port}`,
            httpVersion: "2",
            interceptors:
                token === null
                    ? []
                    : [
                          (next) => (req) => {
                              req.header.set("authorization", `Bearer ${token}`);
                              return next(req);
                          },
                      ],
        });
        let code = "OK";
        let message: string | null = null;
        try {
            message = (await createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "input" }))).message;
        } catch (err) {
            const failure = ConnectError.from(err);
            code = Code[failure.code] ?? String(failure.code);
            message = failure.rawMessage;
        }
        return {
            code,
            message,
            handlerCalls: probe.handlerCalls,
            fallbackCodes: probe.fallbackCodes.map((c) => (c === undefined ? undefined : Code[c])),
        };
    } finally {
        await server.stop();
    }
}

describe("fallback interceptor and a refused call", () => {
    const authOutside = (probe: Probe): Interceptor[] => [authInterceptor(), ...fallbackChain(probe)];
    const authInside = (probe: Probe): Interceptor[] => [...fallbackChain(probe), authInterceptor()];
    const authzInside = (probe: Probe): Interceptor[] => [authInterceptor(), ...fallbackChain(probe), authzInterceptor()];
    const authzOutside = (probe: Probe): Interceptor[] => [authInterceptor(), authzInterceptor(), ...fallbackChain(probe)];

    for (const [label, chain] of [
        ["outside the fallback interceptor", authOutside],
        ["inside the fallback interceptor", authInside],
    ] as const) {
        it(`refuses a call without credentials with Unauthenticated when authentication is ${label}`, async () => {
            const outcome = await call(chain, null);
            assert.strictEqual(outcome.code, "Unauthenticated");
            assert.strictEqual(outcome.handlerCalls, 0);
            assert.deepStrictEqual(outcome.fallbackCodes, [], "the fallback handler is not asked for a value");
        });

        it(`refuses a call with wrong credentials with Unauthenticated when authentication is ${label}`, async () => {
            const outcome = await call(chain, "forged-token");
            assert.strictEqual(outcome.code, "Unauthenticated");
            assert.strictEqual(outcome.handlerCalls, 0);
            assert.deepStrictEqual(outcome.fallbackCodes, []);
        });

        it(`serves a call with valid credentials by the real handler when authentication is ${label}`, async () => {
            const outcome = await call(chain, VALID_TOKEN);
            assert.strictEqual(outcome.code, "OK");
            assert.strictEqual(outcome.message, REAL_MESSAGE);
            assert.deepStrictEqual(outcome.fallbackCodes, []);
        });
    }

    it("refuses an authenticated caller who lacks the role with PermissionDenied when authorization is inside the fallback interceptor", async () => {
        const outcome = await call(authzInside, VALID_TOKEN);
        assert.strictEqual(outcome.code, "PermissionDenied");
        assert.strictEqual(outcome.handlerCalls, 0);
        assert.deepStrictEqual(outcome.fallbackCodes, []);
    });

    it("refuses an authenticated caller who lacks the role with PermissionDenied when authorization is outside the fallback interceptor", async () => {
        const outcome = await call(authzOutside, VALID_TOKEN);
        assert.strictEqual(outcome.code, "PermissionDenied");
        assert.deepStrictEqual(outcome.fallbackCodes, []);
    });

    it("passes on a refusal raised by the service handler itself", async () => {
        const outcome = await call(authOutside, VALID_TOKEN, new ConnectError("not yours", Code.PermissionDenied));
        assert.strictEqual(outcome.code, "PermissionDenied");
        assert.strictEqual(outcome.handlerCalls, 1);
        assert.deepStrictEqual(outcome.fallbackCodes, []);
    });

    for (const [label, failure, expected] of [
        ["Unavailable", new ConnectError("dependency down", Code.Unavailable), "Unavailable"],
        ["DeadlineExceeded", new ConnectError("too slow", Code.DeadlineExceeded), "DeadlineExceeded"],
        ["Internal", new ConnectError("bug", Code.Internal), "Internal"],
    ] as const) {
        it(`still answers with the fallback value when the handler fails with ${label}`, async () => {
            const outcome = await call(authOutside, VALID_TOKEN, failure);
            assert.strictEqual(outcome.code, "OK");
            assert.strictEqual(outcome.message, FALLBACK_MESSAGE);
            assert.deepStrictEqual(outcome.fallbackCodes, [expected]);
        });
    }

    it("still answers with the fallback value when the handler throws a plain Error", async () => {
        const outcome = await call(authOutside, VALID_TOKEN, new Error("plain failure"));
        assert.strictEqual(outcome.code, "OK");
        assert.strictEqual(outcome.message, FALLBACK_MESSAGE);
        assert.strictEqual(outcome.fallbackCodes.length, 1);
    });
});
