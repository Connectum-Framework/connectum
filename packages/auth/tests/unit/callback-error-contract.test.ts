/**
 * Error contract of the user-supplied verification callbacks.
 *
 * A ConnectError thrown by verifyCredentials, verifySession or mapSession reaches the
 * client unchanged (code, message and details), because its author chose it for the client.
 * Any other thrown value is replaced by a fixed Unauthenticated message that carries no text
 * of the original error: a database driver message or a secret must not travel to the caller.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createMockNext, createMockRequest } from "@connectum/testing";
import { createAuthInterceptor } from "../../src/auth-interceptor.ts";
import { createSessionAuthInterceptor } from "../../src/session-auth-interceptor.ts";
import { createMockAuthContext } from "../../src/testing/mock-context.ts";

const SECRET_TEXT = "connect ECONNREFUSED db.internal:5432 password=hunter2";

function bearer(): ReturnType<typeof createMockRequest> {
    return createMockRequest({ headers: new Headers({ authorization: "Bearer t" }) });
}

async function failureOf(run: () => Promise<unknown>): Promise<ConnectError> {
    try {
        await run();
    } catch (err) {
        assert.ok(err instanceof ConnectError, `expected a ConnectError, got ${String(err)}`);
        return err;
    }
    assert.fail("expected the call to be rejected");
}

describe("verification callback error contract", () => {
    describe("verifyCredentials", () => {
        it("passes a ConnectError through with its code and its exact text", async () => {
            const handler = createAuthInterceptor({
                verifyCredentials: async () => {
                    throw new ConnectError("token revoked at 12:00", Code.PermissionDenied);
                },
            })(createMockNext());

            const err = await failureOf(() => handler(bearer()));

            assert.strictEqual(err.code, Code.PermissionDenied);
            assert.strictEqual(err.rawMessage, "token revoked at 12:00");
        });

        it("replaces any other error by a fixed Unauthenticated message without its text", async () => {
            const handler = createAuthInterceptor({
                verifyCredentials: async () => {
                    throw new Error(SECRET_TEXT);
                },
            })(createMockNext());

            const err = await failureOf(() => handler(bearer()));

            assert.strictEqual(err.code, Code.Unauthenticated);
            assert.strictEqual(err.rawMessage, "Authentication failed");
            assert.ok(!err.message.includes("hunter2"));
        });

        it("replaces a thrown non-Error value the same way", async () => {
            const handler = createAuthInterceptor({
                verifyCredentials: async () => {
                    throw SECRET_TEXT;
                },
            })(createMockNext());

            const err = await failureOf(() => handler(bearer()));

            assert.strictEqual(err.code, Code.Unauthenticated);
            assert.strictEqual(err.rawMessage, "Authentication failed");
        });
    });

    describe("verifySession and mapSession", () => {
        it("passes a ConnectError from verifySession through unchanged", async () => {
            const handler = createSessionAuthInterceptor({
                verifySession: async () => {
                    throw new ConnectError("session locked", Code.ResourceExhausted);
                },
                mapSession: async () => createMockAuthContext(),
            })(createMockNext());

            const err = await failureOf(() => handler(bearer()));

            assert.strictEqual(err.code, Code.ResourceExhausted);
            assert.strictEqual(err.rawMessage, "session locked");
        });

        it("replaces another error from verifySession by 'Session verification failed' without its text", async () => {
            const handler = createSessionAuthInterceptor({
                verifySession: async () => {
                    throw new Error(SECRET_TEXT);
                },
                mapSession: async () => createMockAuthContext(),
            })(createMockNext());

            const err = await failureOf(() => handler(bearer()));

            assert.strictEqual(err.code, Code.Unauthenticated);
            assert.strictEqual(err.rawMessage, "Session verification failed");
        });

        it("passes a ConnectError from mapSession through unchanged", async () => {
            const handler = createSessionAuthInterceptor({
                verifySession: async () => ({}),
                mapSession: async () => {
                    throw new ConnectError("tenant suspended", Code.PermissionDenied);
                },
            })(createMockNext());

            const err = await failureOf(() => handler(bearer()));

            assert.strictEqual(err.code, Code.PermissionDenied);
            assert.strictEqual(err.rawMessage, "tenant suspended");
        });

        it("replaces another error from mapSession by 'Session mapping failed' without its text", async () => {
            const handler = createSessionAuthInterceptor({
                verifySession: async () => ({}),
                mapSession: async () => {
                    throw new Error(SECRET_TEXT);
                },
            })(createMockNext());

            const err = await failureOf(() => handler(bearer()));

            assert.strictEqual(err.code, Code.Unauthenticated);
            assert.strictEqual(err.rawMessage, "Session mapping failed");
        });
    });
});
