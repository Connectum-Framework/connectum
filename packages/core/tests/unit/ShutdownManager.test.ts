/**
 * ShutdownManager unit tests
 *
 * Tests for dependency-ordered shutdown hook execution,
 * overloaded addHook() API, and cycle detection.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { ShutdownManager } from "../../src/ShutdownManager.ts";

describe("ShutdownManager", () => {
    // ---------------------------------------------------------------
    // addHook() overloads
    // ---------------------------------------------------------------

    describe("addHook() overloads", () => {
        it("should register and execute anonymous hook via addHook(handler)", async () => {
            const manager = new ShutdownManager();
            const order: string[] = [];

            manager.addHook(() => {
                order.push("anon");
            });

            await manager.executeAll();

            assert.deepStrictEqual(order, ["anon"]);
        });

        it("should register and execute named hook via addHook(name, handler)", async () => {
            const manager = new ShutdownManager();
            const order: string[] = [];

            manager.addHook("cache", () => {
                order.push("cache");
            });

            await manager.executeAll();

            assert.deepStrictEqual(order, ["cache"]);
        });

        it("should register hook with dependencies via addHook(name, deps, handler)", async () => {
            const manager = new ShutdownManager();
            const order: string[] = [];

            manager.addHook("database", () => {
                order.push("database");
            });
            manager.addHook("server", ["database"], () => {
                order.push("server");
            });

            await manager.executeAll();

            assert.ok(order.includes("database"));
            assert.ok(order.includes("server"));
        });
    });

    // ---------------------------------------------------------------
    // Dependency-ordered execution
    // ---------------------------------------------------------------

    describe("dependency-ordered execution", () => {
        it("should execute dependencies before dependents (A depends on B)", async () => {
            const manager = new ShutdownManager();
            const order: string[] = [];

            manager.addHook("cache", async () => {
                order.push("cache");
            });
            manager.addHook("database", ["cache"], async () => {
                order.push("database");
            });

            await manager.executeAll();

            assert.deepStrictEqual(order, ["cache", "database"]);
        });

        it("should execute multiple dependencies before dependent (A depends on [B, C])", async () => {
            const manager = new ShutdownManager();
            const order: string[] = [];

            manager.addHook("cache", async () => {
                order.push("cache");
            });
            manager.addHook("queue", async () => {
                order.push("queue");
            });
            manager.addHook("server", ["cache", "queue"], async () => {
                order.push("server");
            });

            await manager.executeAll();

            // Both dependencies must execute before server
            const serverIndex = order.indexOf("server");
            const cacheIndex = order.indexOf("cache");
            const queueIndex = order.indexOf("queue");

            assert.ok(cacheIndex < serverIndex, "cache should execute before server");
            assert.ok(queueIndex < serverIndex, "queue should execute before server");
            assert.strictEqual(order.length, 3);
        });

        it("should execute independent hooks in parallel", async () => {
            const manager = new ShutdownManager();
            const order: string[] = [];

            manager.addHook("alpha", async () => {
                order.push("alpha");
            });
            manager.addHook("beta", async () => {
                order.push("beta");
            });

            await manager.executeAll();

            // Both hooks should execute (order may vary since they are parallel)
            assert.strictEqual(order.length, 2);
            assert.ok(order.includes("alpha"));
            assert.ok(order.includes("beta"));
        });
    });

    // ---------------------------------------------------------------
    // Cycle detection
    // ---------------------------------------------------------------

    describe("cycle detection", () => {
        it("should throw on direct cycle (A -> B -> A)", () => {
            const manager = new ShutdownManager();

            manager.addHook("a", async () => {});
            manager.addHook("b", ["a"], async () => {});

            assert.throws(
                () => manager.addHook("a", ["b"], async () => {}),
                {
                    name: "Error",
                    message: /cycle/i,
                },
            );
        });

        it("should throw on self-cycle (A -> A)", () => {
            const manager = new ShutdownManager();

            assert.throws(
                () => manager.addHook("a", ["a"], async () => {}),
                {
                    name: "Error",
                    message: /cycle/i,
                },
            );
        });
    });

    // ---------------------------------------------------------------
    // executeAll()
    // ---------------------------------------------------------------

    describe("executeAll()", () => {
        it("should not throw when no hooks are registered", async () => {
            const manager = new ShutdownManager();

            await assert.doesNotReject(async () => {
                await manager.executeAll();
            });
        });

        it("should support being called multiple times", async () => {
            const manager = new ShutdownManager();
            let counter = 0;

            manager.addHook("counter", () => {
                counter++;
            });

            await manager.executeAll();
            assert.strictEqual(counter, 1);

            await manager.executeAll();
            assert.strictEqual(counter, 2);
        });

        it("should execute multiple handlers registered for the same module", async () => {
            const manager = new ShutdownManager();
            const order: string[] = [];

            manager.addHook("database", async () => {
                order.push("database-close-pool");
            });
            manager.addHook("database", async () => {
                order.push("database-flush-logs");
            });

            await manager.executeAll();

            assert.strictEqual(order.length, 2);
            assert.ok(order.includes("database-close-pool"));
            assert.ok(order.includes("database-flush-logs"));
        });
    });
});
