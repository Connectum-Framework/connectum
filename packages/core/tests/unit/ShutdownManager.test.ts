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

        it("should leave the graph and the hooks untouched when a registration is rejected for a cycle", async () => {
            const manager = new ShutdownManager();
            const order: string[] = [];

            manager.addHook("a", slowHook(order, "a"));
            manager.addHook("b", ["a"], slowHook(order, "b"));
            assert.throws(
                () => manager.addHook("a", ["b"], () => {
                    order.push("rejected");
                }),
                { message: /cycle/i },
            );

            // Had the rejected edge a -> b stayed in the graph, the two modules would
            // wait for each other; had the rejected handler stayed registered, it would run.
            await within(manager.executeAll(), 1000, "executeAll() did not settle after a rejected cyclic registration");

            assert.deepStrictEqual(order, ["a", "b"]);
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

        // A hook's failure says nothing about whether other hooks can release their own
        // resources, so a module whose dependency failed still runs once that dependency
        // has finished: running it is what a shutdown exists for.
        it("should still run a hook whose dependency failed, after the dependency finished", async () => {
            const manager = new ShutdownManager();
            const order: string[] = [];

            manager.addHook("database", async () => {
                order.push("database");
                throw new Error("database failed");
            });
            manager.addHook("server", ["database"], () => {
                order.push("server");
            });

            await assert.rejects(() => manager.executeAll(), { message: "database failed" });

            assert.deepStrictEqual(order, ["database", "server"], "the dependent runs after the failed dependency");
        });

        it("should not settle before an independent running hook completes", async () => {
            const manager = new ShutdownManager();
            let releaseSlow!: () => void;
            const slowGate = new Promise<void>((resolve) => {
                releaseSlow = resolve;
            });
            let slowStarted!: () => void;
            const slowRunning = new Promise<void>((resolve) => {
                slowStarted = resolve;
            });
            let slowDone = false;

            manager.addHook("slow", async () => {
                slowStarted();
                await slowGate;
                slowDone = true;
            });
            manager.addHook("failing", async () => {
                // Fail only once the slow hook is running, so it is a started,
                // independent hook at the moment of the failure.
                await slowRunning;
                throw new Error("failing hook");
            });

            let settled = false;
            const outcome = manager.executeAll().then(
                () => {
                    settled = true;
                },
                (err: unknown) => {
                    settled = true;
                    throw err;
                },
            );
            outcome.catch(() => {});
            await delay(50);
            assert.strictEqual(settled, false, "executeAll() must wait for the slow hook although another hook already failed");
            assert.strictEqual(slowDone, false);

            releaseSlow();
            await assert.rejects(() => outcome, { message: "failing hook" });
            assert.strictEqual(slowDone, true, "the slow hook had finished when executeAll() settled");
        });

        it("should reject with the single failure itself, not wrapped", async () => {
            const manager = new ShutdownManager();
            const failure = new Error("only failure");
            manager.addHook("ok", async () => {});
            manager.addHook("bad", async () => {
                throw failure;
            });

            await assert.rejects(
                () => manager.executeAll(),
                (err: unknown) => err === failure,
            );
        });

        it("should report every failure, in registration order, in an AggregateError", async () => {
            const manager = new ShutdownManager();
            const unhandled: unknown[] = [];
            const onUnhandled = (reason: unknown) => unhandled.push(reason);
            process.on("unhandledRejection", onUnhandled);

            // Registered first but failing last: the order of the report is the
            // registration order, not the order the failures happened in.
            manager.addHook("early-registered", async () => {
                await delay(30);
                throw new Error("failure A");
            });
            manager.addHook("late-registered", async () => {
                throw new Error("failure B");
            });
            // Two handlers of one module, one throwing before its first await.
            manager.addHook("shared", () => {
                throw new Error("failure C");
            });
            manager.addHook("shared", async () => {
                throw new Error("failure D");
            });
            manager.addHook("fine", async () => {});

            try {
                await assert.rejects(
                    () => manager.executeAll(),
                    (err: unknown) => {
                        assert.ok(err instanceof AggregateError);
                        assert.deepStrictEqual(
                            err.errors.map((e: Error) => e.message),
                            ["failure A", "failure B", "failure C", "failure D"],
                        );
                        assert.match(err.message, /4 shutdown hooks failed/);
                        return true;
                    },
                );
                await nextTurn();
            } finally {
                process.removeListener("unhandledRejection", onUnhandled);
            }
            assert.deepStrictEqual(unhandled, [], "no failure may escape as an unhandled rejection");
        });

        it("should report a failed dependency and a failed dependent together", async () => {
            const manager = new ShutdownManager();
            manager.addHook("database", async () => {
                throw new Error("database failed");
            });
            manager.addHook("server", ["database"], async () => {
                throw new Error("server failed");
            });

            await assert.rejects(
                () => manager.executeAll(),
                (err: unknown) => err instanceof AggregateError && err.errors.map((e: Error) => e.message).join("|") === "database failed|server failed",
            );
        });

        it("should start every run clean: failures of an earlier run are not reported again", async () => {
            const manager = new ShutdownManager();
            let fail = true;
            manager.addHook("flaky", async () => {
                if (fail) {
                    throw new Error("first run failed");
                }
            });

            await assert.rejects(() => manager.executeAll(), { message: "first run failed" });
            fail = false;
            await manager.executeAll();
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
