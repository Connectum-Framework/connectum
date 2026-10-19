/**
 * performGracefulShutdown() unit tests
 *
 * Tests for graceful shutdown orchestration: close transport, timeout race,
 * session destruction, shutdown hooks, and dispose.
 *
 * Uses mock objects for TransportManager and ShutdownManager since
 * performGracefulShutdown accepts them as parameters.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import type { GracefulShutdownOptions } from "../../src/gracefulShutdown.ts";
import { performGracefulShutdown } from "../../src/gracefulShutdown.ts";
import { ShutdownManager } from "../../src/ShutdownManager.ts";
import type { TransportManager } from "../../src/TransportManager.ts";

/** Extract mock call count from a mock.fn() disguised as a typed method */
function mockCallCount(fn: unknown): number {
    return (fn as ReturnType<typeof mock.fn>).mock.calls.length;
}

/**
 * Create a mock TransportManager with configurable behavior
 */
function createMockTransport(overrides: {
    server?: object | null;
    closeDelay?: number;
    closeError?: Error;
} = {}): TransportManager {
    const { server = {}, closeDelay = 0, closeError } = overrides;

    return {
        get server() {
            return server;
        },
        close: mock.fn(async () => {
            if (closeDelay > 0) {
                await new Promise((resolve) => globalThis.setTimeout(resolve, closeDelay));
            }
            if (closeError) {
                throw closeError;
            }
        }),
        destroyAllSessions: mock.fn(),
        dispose: mock.fn(),
    } as unknown as TransportManager;
}

/**
 * Create a mock ShutdownManager
 */
function createMockShutdownManager(): ShutdownManager & { executeAll: ReturnType<typeof mock.fn> } {
    return {
        executeAll: mock.fn(async () => {}),
        addHook: mock.fn(),
    } as unknown as ShutdownManager & { executeAll: ReturnType<typeof mock.fn> };
}

/**
 * Default options for tests
 */
const defaultOptions: GracefulShutdownOptions = {
    timeout: 5000,
    forceCloseOnTimeout: true,
};

describe("performGracefulShutdown()", () => {
    // -----------------------------------------------------------------
    // Early return when no server
    // -----------------------------------------------------------------

    describe("when transport.server is null", () => {
        it("should return immediately", async () => {
            const transport = createMockTransport({ server: null });
            const shutdownManager = createMockShutdownManager();

            await performGracefulShutdown(transport, shutdownManager, defaultOptions);

            // close() should NOT be called
            assert.strictEqual(mockCallCount(transport.close), 0);
            // executeAll() should NOT be called
            assert.strictEqual(shutdownManager.executeAll.mock.calls.length, 0);
            // dispose() should NOT be called
            assert.strictEqual(mockCallCount(transport.dispose), 0);
        });
    });

    // -----------------------------------------------------------------
    // Normal graceful shutdown (close wins the race)
    // -----------------------------------------------------------------

    describe("when close completes before timeout", () => {
        it("should call transport.close()", async () => {
            const transport = createMockTransport();
            const shutdownManager = createMockShutdownManager();

            await performGracefulShutdown(transport, shutdownManager, defaultOptions);

            assert.strictEqual(mockCallCount(transport.close), 1);
        });

        // Graceful-shutdown guide, steps 3-6: the hooks run once the connections have
        // closed, not while the transport is still draining. A close that finishes inside
        // the timeout must therefore be waited for.
        it("should wait for a close that finishes inside the timeout before running the hooks", async () => {
            let closeFinished = false;
            let closeFinishedAtHooks: boolean | undefined;
            const transport = {
                get server() {
                    return {};
                },
                close: mock.fn(async () => {
                    await new Promise((resolve) => globalThis.setTimeout(resolve, 40));
                    closeFinished = true;
                }),
                destroyAllSessions: mock.fn(),
                dispose: mock.fn(),
            } as unknown as TransportManager;
            const shutdownManager = {
                executeAll: mock.fn(async () => {
                    closeFinishedAtHooks = closeFinished;
                }),
            } as unknown as ShutdownManager;

            await performGracefulShutdown(transport, shutdownManager, { timeout: 5000, forceCloseOnTimeout: true });

            assert.strictEqual(closeFinishedAtHooks, true, "hooks started before the transport finished closing");
            assert.strictEqual(mockCallCount(transport.destroyAllSessions), 0);
        });

        it("should NOT call destroyAllSessions", async () => {
            const transport = createMockTransport();
            const shutdownManager = createMockShutdownManager();

            await performGracefulShutdown(transport, shutdownManager, defaultOptions);

            assert.strictEqual(
                mockCallCount(transport.destroyAllSessions),
                0,
            );
        });

        it("should call shutdownManager.executeAll()", async () => {
            const transport = createMockTransport();
            const shutdownManager = createMockShutdownManager();

            await performGracefulShutdown(transport, shutdownManager, defaultOptions);

            assert.strictEqual(shutdownManager.executeAll.mock.calls.length, 1);
        });

        it("should call transport.dispose() at the end", async () => {
            const transport = createMockTransport();
            const shutdownManager = createMockShutdownManager();

            await performGracefulShutdown(transport, shutdownManager, defaultOptions);

            assert.strictEqual(mockCallCount(transport.dispose), 1);
        });
    });

    // -----------------------------------------------------------------
    // Timeout scenario (timeout wins the race)
    // -----------------------------------------------------------------

    describe("when timeout fires before close completes", () => {
        it("should call destroyAllSessions when forceCloseOnTimeout=true", async () => {
            // close() takes 500ms, timeout is 50ms -- timeout wins
            const transport = createMockTransport({ closeDelay: 500 });
            const shutdownManager = createMockShutdownManager();

            await performGracefulShutdown(transport, shutdownManager, {
                timeout: 50,
                forceCloseOnTimeout: true,
            });

            assert.strictEqual(
                mockCallCount(transport.destroyAllSessions),
                1,
            );
        });

        it("should NOT call destroyAllSessions when forceCloseOnTimeout=false", async () => {
            // close() takes 500ms, timeout is 50ms -- timeout wins
            const transport = createMockTransport({ closeDelay: 500 });
            const shutdownManager = createMockShutdownManager();

            await performGracefulShutdown(transport, shutdownManager, {
                timeout: 50,
                forceCloseOnTimeout: false,
            });

            assert.strictEqual(
                mockCallCount(transport.destroyAllSessions),
                0,
            );
        });

        // Graceful-shutdown guide, "Timeout and Force Close Behavior": with and without
        // force close alike, `stop()` runs the shutdown hooks as soon as the timeout has
        // won, and the transport state is released afterwards.
        for (const forceCloseOnTimeout of [true, false]) {
            it(`should still call executeAll after timeout with forceCloseOnTimeout=${forceCloseOnTimeout}`, async () => {
                const transport = createMockTransport({ closeDelay: 500 });
                const shutdownManager = createMockShutdownManager();

                await performGracefulShutdown(transport, shutdownManager, {
                    timeout: 50,
                    forceCloseOnTimeout,
                });

                assert.strictEqual(shutdownManager.executeAll.mock.calls.length, 1);
            });

            it(`should still call dispose after timeout with forceCloseOnTimeout=${forceCloseOnTimeout}`, async () => {
                const transport = createMockTransport({ closeDelay: 500 });
                const shutdownManager = createMockShutdownManager();

                await performGracefulShutdown(transport, shutdownManager, {
                    timeout: 50,
                    forceCloseOnTimeout,
                });

                assert.strictEqual(mockCallCount(transport.dispose), 1);
            });
        }
    });

    // -----------------------------------------------------------------
    // Error handling
    // -----------------------------------------------------------------

    describe("error handling", () => {
        it("should handle transport.close() rejection gracefully when timeout wins", async () => {
            // close() rejects after 200ms, timeout fires at 50ms
            const transport = createMockTransport({
                closeDelay: 200,
                closeError: new Error("close failed"),
            });
            const shutdownManager = createMockShutdownManager();

            // Should not throw -- the error is caught by the .catch() handler
            await assert.doesNotReject(async () => {
                await performGracefulShutdown(transport, shutdownManager, {
                    timeout: 50,
                    forceCloseOnTimeout: true,
                });
            });

            // Hooks and dispose should still run
            assert.strictEqual(shutdownManager.executeAll.mock.calls.length, 1);
            assert.strictEqual(mockCallCount(transport.dispose), 1);
        });

        // Graceful-shutdown guide: "A close failure that only arrives after the timeout
        // has already won is logged, not thrown". The failure below arrives 150 ms after
        // performGracefulShutdown() has returned, so the test waits for it and checks both
        // halves: it is reported to the log and it does not surface as an unhandled rejection.
        it("should log, and not throw or leave unhandled, a close failure that arrives after the timeout won", async () => {
            const closeError = new Error("close failed late");
            const transport = createMockTransport({ closeDelay: 200, closeError });
            const shutdownManager = createMockShutdownManager();
            const unhandled: unknown[] = [];
            const onUnhandled = (reason: unknown) => unhandled.push(reason);
            const logged: unknown[][] = [];
            const originalError = console.error;
            process.on("unhandledRejection", onUnhandled);
            console.error = (...args: unknown[]) => {
                logged.push(args);
            };

            try {
                await performGracefulShutdown(transport, shutdownManager, { timeout: 50, forceCloseOnTimeout: true });
                assert.strictEqual(logged.length, 0, "the failure had not arrived yet when the shutdown returned");

                await new Promise((resolve) => globalThis.setTimeout(resolve, 300));
            } finally {
                console.error = originalError;
                process.removeListener("unhandledRejection", onUnhandled);
            }

            assert.ok(
                logged.some((args) => args.includes(closeError)),
                "the late close failure must be logged",
            );
            assert.deepStrictEqual(unhandled, []);
        });

        // Hooks release the application's own resources (brokers, databases);
        // a listener that fails to close cleanly must not make shutdown skip
        // them. The close error is still reported to the caller afterwards.
        // Disposal releases the transport's own state and must not depend on the
        // application's hooks succeeding: the hook failure is reported only after it.
        it("should dispose the transport and re-throw the hook failure when a real hook rejects", async () => {
            const hookError = new Error("hook failed");
            const transport = createMockTransport();
            const shutdownManager = new ShutdownManager();
            shutdownManager.addHook("failing", async () => {
                throw hookError;
            });

            await assert.rejects(
                () => performGracefulShutdown(transport, shutdownManager, defaultOptions),
                (err: unknown) => err === hookError,
            );

            assert.strictEqual(mockCallCount(transport.dispose), 1, "transport state must be disposed despite the hook failure");
        });

        it("should run hooks and dispose, then re-throw, when transport.close() rejects before the timeout", async () => {
            const closeError = new Error("close failed");
            const transport = createMockTransport({ closeError });
            const shutdownManager = createMockShutdownManager();

            await assert.rejects(
                () => performGracefulShutdown(transport, shutdownManager, defaultOptions),
                (err: unknown) => err === closeError,
            );

            assert.strictEqual(shutdownManager.executeAll.mock.calls.length, 1, "hooks must run despite the close failure");
            assert.strictEqual(mockCallCount(transport.dispose), 1, "transport state must be disposed despite the close failure");
            assert.strictEqual(mockCallCount(transport.destroyAllSessions), 0, "a close failure is not a timeout: nothing is force-closed");
        });
    });

    // -----------------------------------------------------------------
    // Timer cleanup (no leak)
    // -----------------------------------------------------------------

    describe("timer cleanup", () => {
        /**
         * Run `fn` while recording the handle of every timer armed with `delayMs` and every
         * handle passed to `clearTimeout` (patched by hand: `mock.method` does not exist
         * under Bun).
         */
        async function trackTimer(delayMs: number, fn: () => Promise<void>): Promise<{ armed: unknown[]; cleared: unknown[] }> {
            const originalSetTimeout = globalThis.setTimeout;
            const originalClearTimeout = globalThis.clearTimeout;
            const armed: unknown[] = [];
            const cleared: unknown[] = [];
            globalThis.setTimeout = ((handler: () => void, delay?: number, ...args: unknown[]) => {
                const handle = originalSetTimeout(handler, delay, ...args);
                if (delay === delayMs) armed.push(handle);
                return handle;
            }) as typeof globalThis.setTimeout;
            globalThis.clearTimeout = ((handle?: Parameters<typeof originalClearTimeout>[0]) => {
                cleared.push(handle);
                return originalClearTimeout(handle);
            }) as typeof globalThis.clearTimeout;
            try {
                await fn();
            } finally {
                globalThis.setTimeout = originalSetTimeout;
                globalThis.clearTimeout = originalClearTimeout;
            }
            return { armed, cleared };
        }

        // A timer that outlives the shutdown keeps the host process alive until it fires,
        // so the very timer armed for the graceful phase has to be the one cancelled.
        it("should cancel the timeout timer it armed when close completes before the timeout", async () => {
            const transport = createMockTransport();
            const shutdownManager = createMockShutdownManager();

            const { armed, cleared } = await trackTimer(7777, () => performGracefulShutdown(transport, shutdownManager, { timeout: 7777, forceCloseOnTimeout: true }));

            assert.strictEqual(armed.length, 1, "exactly one graceful-phase timer is armed");
            assert.ok(cleared.includes(armed[0]), "the armed timer must be the one that is cancelled");
        });

        it("should cancel the timeout timer it armed when the timeout fires", async () => {
            const transport = createMockTransport({ closeDelay: 500 });
            const shutdownManager = createMockShutdownManager();

            const { armed, cleared } = await trackTimer(50, () => performGracefulShutdown(transport, shutdownManager, { timeout: 50, forceCloseOnTimeout: true }));

            assert.strictEqual(armed.length, 1);
            assert.ok(cleared.includes(armed[0]), "the armed timer must be cancelled even after it fired");
        });

        it("should cancel the timeout timer it armed when transport.close() rejects", async () => {
            const transport = createMockTransport({ closeError: new Error("close failed") });
            const shutdownManager = createMockShutdownManager();

            const { armed, cleared } = await trackTimer(7777, () =>
                performGracefulShutdown(transport, shutdownManager, { timeout: 7777, forceCloseOnTimeout: true }).then(
                    () => assert.fail("the close failure must be reported"),
                    () => undefined,
                ),
            );

            assert.strictEqual(armed.length, 1);
            assert.ok(cleared.includes(armed[0]), "a failed close must not leave the graceful-phase timer armed");
        });
    });

    // -----------------------------------------------------------------
    // Execution order
    // -----------------------------------------------------------------

    describe("execution order", () => {
        it("should execute close -> executeAll -> dispose in order", async () => {
            const order: string[] = [];

            const transport = {
                get server() {
                    return {};
                },
                close: mock.fn(async () => {
                    order.push("close");
                }),
                destroyAllSessions: mock.fn(() => {
                    order.push("destroyAllSessions");
                }),
                dispose: mock.fn(() => {
                    order.push("dispose");
                }),
            } as unknown as TransportManager;

            const shutdownManager = {
                executeAll: mock.fn(async () => {
                    order.push("executeAll");
                }),
            } as unknown as ShutdownManager;

            await performGracefulShutdown(transport, shutdownManager, defaultOptions);

            assert.deepStrictEqual(order, ["close", "executeAll", "dispose"]);
        });

        it("should execute close -> destroyAllSessions -> executeAll -> dispose on timeout", async () => {
            const order: string[] = [];

            const transport = {
                get server() {
                    return {};
                },
                close: mock.fn(async () => {
                    await new Promise((resolve) => globalThis.setTimeout(resolve, 500));
                    order.push("close");
                }),
                destroyAllSessions: mock.fn(() => {
                    order.push("destroyAllSessions");
                }),
                dispose: mock.fn(() => {
                    order.push("dispose");
                }),
            } as unknown as TransportManager;

            const shutdownManager = {
                executeAll: mock.fn(async () => {
                    order.push("executeAll");
                }),
            } as unknown as ShutdownManager;

            await performGracefulShutdown(transport, shutdownManager, {
                timeout: 50,
                forceCloseOnTimeout: true,
            });

            assert.deepStrictEqual(order, ["destroyAllSessions", "executeAll", "dispose"]);
        });
    });

    // -----------------------------------------------------------------
    // shutdownManager.executeAll() throws
    // -----------------------------------------------------------------

    describe("when shutdownManager.executeAll() throws", () => {
        it("should propagate the error", async () => {
            const transport = createMockTransport();
            const shutdownManager = {
                executeAll: mock.fn(async () => {
                    throw new Error("hook explosion");
                }),
                addHook: mock.fn(),
            } as unknown as ShutdownManager & { executeAll: ReturnType<typeof mock.fn> };

            await assert.rejects(
                () => performGracefulShutdown(transport, shutdownManager, defaultOptions),
                { message: "hook explosion" },
            );
            // A failing hook must not leave the transport state behind.
            assert.strictEqual(mockCallCount(transport.dispose), 1, "transport must be disposed even when a hook fails");
        });

        // When both the transport close and a hook fail, the caller must see
        // both errors — reporting only one would hide the other failure.
        it("should report both errors when transport.close() and a hook fail", async () => {
            const closeError = new Error("close failed");
            const hookError = new Error("hook explosion");
            const transport = createMockTransport({ closeError });
            const shutdownManager = {
                executeAll: mock.fn(async () => {
                    throw hookError;
                }),
                addHook: mock.fn(),
            } as unknown as ShutdownManager & { executeAll: ReturnType<typeof mock.fn> };

            await assert.rejects(
                () => performGracefulShutdown(transport, shutdownManager, defaultOptions),
                (err: unknown) => err instanceof AggregateError && err.errors[0] === closeError && err.errors[1] === hookError,
            );
            assert.strictEqual(mockCallCount(transport.dispose), 1, "transport must be disposed even when both steps fail");
        });
    });

    // -----------------------------------------------------------------
    // timeout: 0 — immediate timeout path
    // -----------------------------------------------------------------

    describe("when timeout is 0", () => {
        it("should take the timeout path immediately and call destroyAllSessions", async () => {
            // close() has a small delay so timeout=0 should always win
            const transport = createMockTransport({ closeDelay: 50 });
            const shutdownManager = createMockShutdownManager();

            await performGracefulShutdown(transport, shutdownManager, {
                timeout: 0,
                forceCloseOnTimeout: true,
            });

            assert.strictEqual(
                mockCallCount(transport.destroyAllSessions),
                1,
                "destroyAllSessions should be called when timeout is 0",
            );

            // Hooks and dispose should still run
            assert.strictEqual(shutdownManager.executeAll.mock.calls.length, 1);
            assert.strictEqual(mockCallCount(transport.dispose), 1);
        });
    });
});
