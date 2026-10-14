/**
 * ShutdownManager unit tests
 *
 * Tests for dependency-ordered shutdown hook execution,
 * overloaded addHook() API, and cycle detection.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { setTimeout as delay, setImmediate as nextTurn } from "node:timers/promises";
import { ShutdownManager } from "../../src/ShutdownManager.ts";

/** A hook that yields to the event loop before recording itself, so a hook that does not wait for its dependency would finish first. */
function slowHook(order: string[], label: string): () => Promise<void> {
    return async () => {
        await nextTurn();
        order.push(label);
    };
}

/**
 * Reject if `work` does not settle within `ms`: two hooks that wait for each
 * other to start can only both finish when they really run in parallel, and a
 * sequential implementation would otherwise hang the test instead of failing it.
 */
async function within(work: Promise<unknown>, ms: number, message: string): Promise<void> {
    const ac = new AbortController();
    const timeout = delay(ms, undefined, { signal: ac.signal }).then(
        () => {
            throw new Error(message);
        },
        () => undefined,
    );
    try {
        await Promise.race([work, timeout]);
    } finally {
        ac.abort();
    }
}

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

            // The dependent is registered first and its dependency is slow, so
            // the dependency is honoured only if the dependent waits for it.
            manager.addHook("server", ["database"], slowHook(order, "server"));
            manager.addHook("database", async () => {
                await nextTurn();
                await nextTurn();
                order.push("database");
            });

            await manager.executeAll();

            assert.deepStrictEqual(order, ["database", "server"]);
        });
    });

    // ---------------------------------------------------------------
    // Dependency-ordered execution
    // ---------------------------------------------------------------

    describe("dependency-ordered execution", () => {
        it("should execute dependencies before dependents (A depends on B)", async () => {
            const manager = new ShutdownManager();
            const order: string[] = [];

            // The dependent is registered before its dependency, so registration
            // order alone would run it first.
            manager.addHook("database", ["cache"], async () => {
                order.push("database");
            });
            manager.addHook("cache", slowHook(order, "cache"));

            await manager.executeAll();

            assert.deepStrictEqual(order, ["cache", "database"]);
        });

        it("should execute multiple dependencies before dependent (A depends on [B, C])", async () => {
            const manager = new ShutdownManager();
            const order: string[] = [];

            // The dependent is registered first and both dependencies are slow:
            // it is last only if it waits for every one of them.
            manager.addHook("server", ["cache", "queue"], async () => {
                order.push("server");
            });
            manager.addHook("cache", slowHook(order, "cache"));
            manager.addHook("queue", async () => {
                await nextTurn();
                await nextTurn();
                order.push("queue");
            });

            await manager.executeAll();

            assert.deepStrictEqual(order, ["cache", "queue", "server"]);
        });

        it("should execute independent hooks in parallel", async () => {
            const manager = new ShutdownManager();
            const started = new Set<string>();
            let bothStarted!: () => void;
            const rendezvous = new Promise<void>((resolve) => {
                bothStarted = resolve;
            });
            const hook = (label: string) => async () => {
                started.add(label);
                if (started.size === 2) bothStarted();
                // Each hook finishes only after the other one has started:
                // run one after the other, the first would wait forever.
                await rendezvous;
            };

            manager.addHook("alpha", hook("alpha"));
            manager.addHook("beta", hook("beta"));

            await within(manager.executeAll(), 1000, "independent hooks did not run in parallel");

            assert.deepStrictEqual([...started].sort(), ["alpha", "beta"]);
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
            const started = new Set<string>();
            let bothStarted!: () => void;
            const rendezvous = new Promise<void>((resolve) => {
                bothStarted = resolve;
            });
            const handler = (label: string) => async () => {
                started.add(label);
                if (started.size === 2) bothStarted();
                // Handlers of one module run in parallel: each finishes only
                // after the other has started.
                await rendezvous;
            };

            manager.addHook("database", handler("database-close-pool"));
            manager.addHook("database", handler("database-flush-logs"));

            await within(manager.executeAll(), 1000, "handlers of the same module did not run in parallel");

            assert.deepStrictEqual([...started].sort(), ["database-close-pool", "database-flush-logs"]);
        });
    });

    // ---------------------------------------------------------------
    // Transitive dependency chain
    // ---------------------------------------------------------------

    describe("transitive dependency chain", () => {
        it("should execute A→B→C in order C, B, A", async () => {
            const manager = new ShutdownManager();
            const order: string[] = [];

            // Registered in the opposite order to the expected execution, with
            // slow dependencies, so only the dependency chain can produce c, b, a.
            manager.addHook("a", ["b"], async () => {
                order.push("a");
            });
            manager.addHook("b", ["c"], slowHook(order, "b"));
            manager.addHook("c", slowHook(order, "c"));

            await manager.executeAll();

            assert.deepStrictEqual(order, ["c", "b", "a"]);
        });
    });

    // ---------------------------------------------------------------
    // Diamond dependency
    // ---------------------------------------------------------------

    describe("diamond dependency", () => {
        it("should execute D exactly once when A→(B,C), B→D, C→D", async () => {
            const manager = new ShutdownManager();
            const order: string[] = [];

            // Registered dependents-first with slow dependencies, so the order
            // below can only come from waiting on dependencies.
            manager.addHook("a", ["b", "c"], async () => {
                order.push("a");
            });
            manager.addHook("b", ["d"], slowHook(order, "b"));
            manager.addHook("c", ["d"], slowHook(order, "c"));
            manager.addHook("d", slowHook(order, "d"));

            await manager.executeAll();

            // d once and first, then its two dependents (parallel, either order), a last.
            assert.strictEqual(order.filter((x) => x === "d").length, 1, "D should execute exactly once");
            assert.strictEqual(order[0], "d");
            assert.deepStrictEqual(order.slice(1, 3).sort(), ["b", "c"]);
            assert.strictEqual(order[3], "a");
            assert.strictEqual(order.length, 4);
        });
    });

    // ---------------------------------------------------------------
    // Indirect cycle detection
    // ---------------------------------------------------------------

    describe("indirect cycle detection", () => {
        it("should throw on indirect cycle A→B→C→A", () => {
            const manager = new ShutdownManager();

            manager.addHook("a", async () => {});
            manager.addHook("b", ["a"], async () => {});
            manager.addHook("c", ["b"], async () => {});

            assert.throws(
                () => manager.addHook("a", ["c"], async () => {}),
                {
                    name: "Error",
                    message: /cycle/i,
                },
            );
        });
    });

    // ---------------------------------------------------------------
    // Error handling in hooks
    // ---------------------------------------------------------------

    describe("hook error handling", () => {
        it("should not prevent other independent hooks from executing when one throws", async () => {
            const manager = new ShutdownManager();
            const order: string[] = [];

            manager.addHook("failing", async () => {
                order.push("failing");
                throw new Error("hook failure");
            });
            manager.addHook("surviving", async () => {
                order.push("surviving");
            });
            // An independent hook that is still working when the other one
            // fails: a failure must not stop it from running to completion.
            manager.addHook("slow-surviving", async () => {
                await delay(20);
                order.push("slow-surviving");
            });

            await assert.rejects(
                () => manager.executeAll(),
                { message: "hook failure" },
            );

            assert.ok(order.includes("failing"), "failing hook should have executed");
            assert.ok(order.includes("surviving"), "surviving hook should have executed");

            await delay(100);
            assert.ok(order.includes("slow-surviving"), "an independent hook must still run to completion after another one fails");
        });

        it("should propagate rejection from async hook", async () => {
            const manager = new ShutdownManager();

            manager.addHook("async-fail", async () => {
                throw new Error("async rejection");
            });

            await assert.rejects(
                () => manager.executeAll(),
                { message: "async rejection" },
            );
        });
    });
});
