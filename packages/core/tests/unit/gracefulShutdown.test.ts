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
import type { ShutdownManager } from "../../src/ShutdownManager.ts";
import type { TransportManager } from "../../src/TransportManager.ts";
import { performGracefulShutdown } from "../../src/gracefulShutdown.ts";
import type { GracefulShutdownOptions } from "../../src/gracefulShutdown.ts";

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

        it("should still call executeAll after timeout", async () => {
            const transport = createMockTransport({ closeDelay: 500 });
            const shutdownManager = createMockShutdownManager();

            await performGracefulShutdown(transport, shutdownManager, {
                timeout: 50,
                forceCloseOnTimeout: true,
            });

            assert.strictEqual(shutdownManager.executeAll.mock.calls.length, 1);
        });

        it("should still call dispose after timeout", async () => {
            const transport = createMockTransport({ closeDelay: 500 });
            const shutdownManager = createMockShutdownManager();

            await performGracefulShutdown(transport, shutdownManager, {
                timeout: 50,
                forceCloseOnTimeout: true,
            });

            assert.strictEqual(mockCallCount(transport.dispose), 1);
        });
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
    });

    // -----------------------------------------------------------------
    // Timer cleanup (no leak)
    // -----------------------------------------------------------------

    describe("timer cleanup", () => {
        it("should not leak timers when close completes before timeout", async () => {
            // Spy on clearTimeout to verify it's called
            const originalClearTimeout = globalThis.clearTimeout;
            let clearTimeoutCalled = false;
            globalThis.clearTimeout = ((...args: Parameters<typeof originalClearTimeout>) => {
                clearTimeoutCalled = true;
                return originalClearTimeout(...args);
            }) as typeof globalThis.clearTimeout;

            try {
                const transport = createMockTransport();
                const shutdownManager = createMockShutdownManager();

                await performGracefulShutdown(transport, shutdownManager, defaultOptions);

                assert.strictEqual(clearTimeoutCalled, true, "clearTimeout should be called");
            } finally {
                globalThis.clearTimeout = originalClearTimeout;
            }
        });

        it("should not leak timers when timeout fires", async () => {
            const originalClearTimeout = globalThis.clearTimeout;
            let clearTimeoutCalled = false;
            globalThis.clearTimeout = ((...args: Parameters<typeof originalClearTimeout>) => {
                clearTimeoutCalled = true;
                return originalClearTimeout(...args);
            }) as typeof globalThis.clearTimeout;

            try {
                const transport = createMockTransport({ closeDelay: 500 });
                const shutdownManager = createMockShutdownManager();

                await performGracefulShutdown(transport, shutdownManager, {
                    timeout: 50,
                    forceCloseOnTimeout: true,
                });

                assert.strictEqual(clearTimeoutCalled, true, "clearTimeout should be called even on timeout");
            } finally {
                globalThis.clearTimeout = originalClearTimeout;
            }
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
});
