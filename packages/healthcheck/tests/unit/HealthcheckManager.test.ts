import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { createHealthcheckManager, HealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

describe("HealthcheckManager", () => {
    let manager: HealthcheckManager;

    beforeEach(() => {
        manager = new HealthcheckManager();
    });

    describe("initialize", () => {
        it("should initialize services with UNKNOWN status", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);

            const foo = manager.getStatus("svc.v1.Foo");
            const bar = manager.getStatus("svc.v1.Bar");

            assert.strictEqual(foo?.status, ServingStatus.UNKNOWN);
            assert.strictEqual(bar?.status, ServingStatus.UNKNOWN);
        });

        it("should overwrite previous initialization", () => {
            manager.initialize(["svc.v1.Foo"]);
            manager.initialize(["svc.v1.Bar"]);

            assert.strictEqual(manager.getStatus("svc.v1.Foo"), undefined);
            assert.strictEqual(manager.getStatus("svc.v1.Bar")?.status, ServingStatus.UNKNOWN);
        });
    });

    describe("update", () => {
        beforeEach(() => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);
        });

        it("should update a specific service", () => {
            manager.update(ServingStatus.SERVING, "svc.v1.Foo");

            assert.strictEqual(manager.getStatus("svc.v1.Foo")?.status, ServingStatus.SERVING);
            assert.strictEqual(manager.getStatus("svc.v1.Bar")?.status, ServingStatus.UNKNOWN);
        });

        it("should update ALL services when called without service name", () => {
            manager.update(ServingStatus.SERVING);

            assert.strictEqual(manager.getStatus("svc.v1.Foo")?.status, ServingStatus.SERVING);
            assert.strictEqual(manager.getStatus("svc.v1.Bar")?.status, ServingStatus.SERVING);
        });

        it("should throw error for unknown service name", () => {
            assert.throws(
                () => manager.update(ServingStatus.SERVING, "svc.v1.Unknown"),
                /Unknown service 'svc.v1.Unknown'/,
            );
        });

        // "Without a service name, update() updates all registered entries":
        // with none registered it has nothing to update, so it must neither
        // fail nor invent an entry that would make an empty registry look
        // healthy (an empty registry is never healthy).
        it("updating all entries of an empty manager creates nothing and leaves it unhealthy", () => {
            const emptyManager = new HealthcheckManager();

            emptyManager.update(ServingStatus.SERVING);

            assert.strictEqual(emptyManager.getAllStatuses().size, 0);
            assert.strictEqual(emptyManager.areAllHealthy(), false);
        });
    });

    describe("getStatus", () => {
        it("should return undefined for unregistered service", () => {
            assert.strictEqual(manager.getStatus("nonexistent"), undefined);
        });

        it("should return current status for registered service", () => {
            manager.initialize(["svc.v1.Foo"]);
            manager.update(ServingStatus.NOT_SERVING, "svc.v1.Foo");

            assert.strictEqual(manager.getStatus("svc.v1.Foo")?.status, ServingStatus.NOT_SERVING);
        });
    });

    describe("getAllStatuses", () => {
        // The result feeds Health.List, which the protocol defines as a
        // snapshot. Each entry carries the serving status and nothing else:
        // the internal service/component kind must not leak into it.
        it("should return a snapshot holding only the status of every entry", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);
            manager.register("process");
            const snapshot = manager.getAllStatuses();

            assert.deepStrictEqual(
                [...snapshot.entries()],
                [
                    ["svc.v1.Foo", { status: ServingStatus.UNKNOWN }],
                    ["svc.v1.Bar", { status: ServingStatus.UNKNOWN }],
                    ["process", { status: ServingStatus.UNKNOWN }],
                ],
            );

            // Later changes of the manager do not rewrite an earlier snapshot.
            manager.update(ServingStatus.SERVING);
            assert.strictEqual(snapshot.get("svc.v1.Foo")?.status, ServingStatus.UNKNOWN);

            // Changing the snapshot does not write through to the manager.
            snapshot.get("svc.v1.Bar")!.status = ServingStatus.NOT_SERVING;
            snapshot.delete("process");
            snapshot.clear();
            assert.strictEqual(manager.getStatus("svc.v1.Bar")?.status, ServingStatus.SERVING);
            assert.strictEqual(manager.getAllStatuses().size, 3);
        });
    });

    describe("areAllHealthy", () => {
        // An empty registry has no evidence that anything is ready, so it is
        // never healthy: a worker without RPCs must register a component to
        // become ready. This holds for a fresh manager and for one that was
        // healthy and then emptied.
        it("should return false when no services registered", () => {
            assert.strictEqual(manager.areAllHealthy(), false);

            manager.initialize(["svc.v1.Foo"]);
            manager.update(ServingStatus.SERVING);
            assert.strictEqual(manager.areAllHealthy(), true, "precondition: a tracked SERVING service is healthy");

            manager.clear();
            assert.strictEqual(manager.areAllHealthy(), false);
        });

        it("should return false when some services are not SERVING", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);
            manager.update(ServingStatus.SERVING, "svc.v1.Foo");

            assert.strictEqual(manager.areAllHealthy(), false);
        });

        it("should return true when all services are SERVING", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);
            manager.update(ServingStatus.SERVING);

            assert.strictEqual(manager.areAllHealthy(), true);
        });
    });

    describe("clear", () => {
        it("should remove all services", () => {
            manager.initialize(["svc.v1.Foo"]);
            manager.clear();

            assert.strictEqual(manager.getStatus("svc.v1.Foo"), undefined);
            assert.strictEqual(manager.getAllStatuses().size, 0);
        });
    });
});

describe("createHealthcheckManager", () => {
    it("should return a new independent instance", () => {
        const manager1 = createHealthcheckManager();
        const manager2 = createHealthcheckManager();

        // Different instances
        assert.notStrictEqual(manager1, manager2);

        // Independent state: modifying one does not affect the other
        manager1.initialize(["svc.v1.Alpha"]);
        manager1.update(ServingStatus.SERVING, "svc.v1.Alpha");

        assert.strictEqual(manager1.getStatus("svc.v1.Alpha")?.status, ServingStatus.SERVING);
        assert.strictEqual(manager2.getStatus("svc.v1.Alpha"), undefined);
        assert.strictEqual(manager2.getAllStatuses().size, 0);
    });
});

describe("HealthcheckManager — additional scenarios", () => {
    let manager: HealthcheckManager;

    beforeEach(() => {
        manager = new HealthcheckManager();
    });

    describe("initialize merge behavior", () => {
        // Re-initialization keeps what the application already reported for a
        // service that is still mounted, starts a newly mounted one as UNKNOWN
        // and drops one that is gone (a dropped service must not stay SERVING).
        it("should preserve existing service status when re-initialized with overlapping names", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar", "svc.v1.Qux"]);
            manager.update(ServingStatus.SERVING, "svc.v1.Foo");
            manager.update(ServingStatus.NOT_SERVING, "svc.v1.Bar");
            manager.update(ServingStatus.SERVING, "svc.v1.Qux");

            // Re-initialize with overlapping "Foo" and "Bar", new "Baz", without "Qux"
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar", "svc.v1.Baz"]);

            assert.strictEqual(
                manager.getStatus("svc.v1.Foo")?.status,
                ServingStatus.SERVING,
                "Overlapping SERVING service should retain its status",
            );
            assert.strictEqual(
                manager.getStatus("svc.v1.Bar")?.status,
                ServingStatus.NOT_SERVING,
                "Overlapping NOT_SERVING service should retain its status, not be reset to UNKNOWN",
            );
            assert.strictEqual(
                manager.getStatus("svc.v1.Baz")?.status,
                ServingStatus.UNKNOWN,
                "New service should start as UNKNOWN",
            );
            assert.strictEqual(
                manager.getStatus("svc.v1.Qux"),
                undefined,
                "Service not in new list should be removed",
            );
            assert.strictEqual(manager.getAllStatuses().size, 3);
        });

        it("should clear all services when initialized with empty array", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);
            assert.strictEqual(manager.getAllStatuses().size, 2);

            manager.initialize([]);

            assert.strictEqual(manager.getAllStatuses().size, 0);
            assert.strictEqual(manager.getStatus("svc.v1.Foo"), undefined);
            assert.strictEqual(manager.getStatus("svc.v1.Bar"), undefined);
        });

        // Health.List returns a map keyed by service name, so a name given
        // more than once appears once. Repeating a name must also not reset
        // the status the application already set.
        it("should deduplicate when initialized with duplicate names", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Foo", "svc.v1.Foo"]);

            assert.deepStrictEqual([...manager.getAllStatuses().keys()], ["svc.v1.Foo"]);
            assert.strictEqual(manager.getStatus("svc.v1.Foo")?.status, ServingStatus.UNKNOWN);

            manager.update(ServingStatus.SERVING, "svc.v1.Foo");
            manager.initialize(["svc.v1.Foo", "svc.v1.Foo"]);

            assert.deepStrictEqual([...manager.getAllStatuses().keys()], ["svc.v1.Foo"]);
            assert.strictEqual(manager.getStatus("svc.v1.Foo")?.status, ServingStatus.SERVING);
        });
    });

    describe("areAllHealthy edge cases", () => {
        it("should return false with mixed SERVING + NOT_SERVING statuses", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);
            manager.update(ServingStatus.SERVING, "svc.v1.Foo");
            manager.update(ServingStatus.NOT_SERVING, "svc.v1.Bar");

            assert.strictEqual(manager.areAllHealthy(), false);
        });

        it("should return false with mixed SERVING + UNKNOWN statuses", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);
            manager.update(ServingStatus.SERVING, "svc.v1.Foo");
            // Bar remains UNKNOWN from initialization

            assert.strictEqual(manager.areAllHealthy(), false);
        });

        it("should return false when all services are NOT_SERVING", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);
            manager.update(ServingStatus.NOT_SERVING);

            assert.strictEqual(manager.areAllHealthy(), false);
        });
    });
});

describe("HealthcheckManager components", () => {
    let manager: HealthcheckManager;

    beforeEach(() => {
        manager = new HealthcheckManager();
    });

    describe("register", () => {
        it("should register a component with UNKNOWN status by default", () => {
            manager.register("process");

            assert.strictEqual(manager.getStatus("process")?.status, ServingStatus.UNKNOWN);
            assert.ok(manager.getAllStatuses().has("process"));
        });

        it("should register a component with explicit initial status", () => {
            manager.register("amqp", ServingStatus.NOT_SERVING);

            assert.strictEqual(manager.getStatus("amqp")?.status, ServingStatus.NOT_SERVING);
        });

        it("should not reset status on re-register", () => {
            manager.register("process");
            manager.set("process", ServingStatus.SERVING);
            manager.register("process");

            assert.strictEqual(manager.getStatus("process")?.status, ServingStatus.SERVING);
        });

        // Dotted names are reserved for RPC service typeNames, so a component
        // name is non-empty and dot-free. A rejected call must leave the
        // registry exactly as it was.
        it("should reject empty component name", () => {
            manager.register("keep");

            assert.throws(() => manager.register(""), Error);

            assert.deepStrictEqual([...manager.getAllStatuses().keys()], ["keep"]);
        });

        for (const name of ["acme.process", "a.b", ".leading", "trailing.", "svc.v1.Foo"]) {
            it(`should reject dotted component name '${name}'`, () => {
                manager.register("keep");

                assert.throws(() => manager.register(name), /must not contain dots/);

                assert.deepStrictEqual([...manager.getAllStatuses().keys()], ["keep"]);
            });
        }

        // A package-less (dot-free) service name passes name validation and
        // reaches the kind check, which must refuse to turn the service into a
        // component or touch its status.
        it("should reject register() of a name already held by an RPC service", () => {
            manager.initialize(["Health"]);
            manager.update(ServingStatus.SERVING, "Health");

            assert.throws(() => manager.register("Health", ServingStatus.NOT_SERVING), /registered RPC service/);

            assert.strictEqual(manager.getStatus("Health")?.status, ServingStatus.SERVING);
            // Still a service: protocol re-initialization without it removes it.
            manager.initialize([]);
            assert.strictEqual(manager.getStatus("Health"), undefined);
        });
    });

    describe("set (upsert)", () => {
        it("should reject set() of a name already held by an RPC service", () => {
            manager.initialize(["Health"]);

            assert.throws(() => manager.set("Health", ServingStatus.SERVING), /registered RPC service/);

            // The refused call changed neither the status nor the entry kind.
            assert.strictEqual(manager.getStatus("Health")?.status, ServingStatus.UNKNOWN);
            manager.initialize([]);
            assert.strictEqual(manager.getStatus("Health"), undefined);
        });

        it("should register an unknown component on set", () => {
            manager.set("process", ServingStatus.SERVING);

            assert.strictEqual(manager.getStatus("process")?.status, ServingStatus.SERVING);
        });

        it("should update an existing component", () => {
            manager.register("process");
            manager.set("process", ServingStatus.SERVING);
            manager.set("process", ServingStatus.NOT_SERVING);

            assert.strictEqual(manager.getStatus("process")?.status, ServingStatus.NOT_SERVING);
        });

        it("should reject empty and dotted names without creating an entry", () => {
            assert.throws(() => manager.set("", ServingStatus.SERVING), Error);
            for (const name of ["a.b", ".leading", "trailing.", "svc.v1.Foo"]) {
                assert.throws(() => manager.set(name, ServingStatus.SERVING), /must not contain dots/, name);
            }

            assert.strictEqual(manager.getAllStatuses().size, 0);
        });
    });

    describe("unregister", () => {
        it("should remove a component", () => {
            manager.register("process");
            manager.unregister("process");

            assert.strictEqual(manager.getStatus("process"), undefined);
        });

        // Removing something that is not there neither fails nor disturbs what is.
        it("should be a no-op for unknown names", () => {
            manager.register("keep", ServingStatus.SERVING);
            manager.initialize(["svc.v1.Foo"]);

            manager.unregister("ghost");

            assert.deepStrictEqual(
                [...manager.getAllStatuses().entries()],
                [
                    ["keep", { status: ServingStatus.SERVING }],
                    ["svc.v1.Foo", { status: ServingStatus.UNKNOWN }],
                ],
            );
        });

        it("should reject unregistering an RPC service and keep it tracked", () => {
            manager.initialize(["svc.v1.Foo"]);
            manager.update(ServingStatus.SERVING, "svc.v1.Foo");

            assert.throws(() => manager.unregister("svc.v1.Foo"), /registered RPC service/);

            // The refusal must not have removed the service or reset its status.
            assert.strictEqual(manager.getStatus("svc.v1.Foo")?.status, ServingStatus.SERVING);
        });
    });

    describe("kind collision", () => {
        it("update() works for components by name", () => {
            manager.register("process");
            manager.update(ServingStatus.SERVING, "process");

            assert.strictEqual(manager.getStatus("process")?.status, ServingStatus.SERVING);
        });

        it("update() without name updates components too", () => {
            manager.initialize(["svc.v1.Foo"]);
            manager.register("process");
            manager.update(ServingStatus.SERVING);

            assert.strictEqual(manager.getStatus("svc.v1.Foo")?.status, ServingStatus.SERVING);
            assert.strictEqual(manager.getStatus("process")?.status, ServingStatus.SERVING);
        });
    });

    describe("initialize after update", () => {
        // update() rewrites an entry's status; it must not change who owns the
        // entry. A component updated by name or in bulk is still the
        // application's and survives protocol initialization; an RPC service
        // updated the same way is still the protocol's and is dropped when it
        // is no longer mounted.
        it("keeps a component updated by update() through re-initialization", () => {
            manager.register("process");
            manager.update(ServingStatus.SERVING, "process");
            manager.initialize([]);
            assert.strictEqual(manager.getStatus("process")?.status, ServingStatus.SERVING);

            manager.update(ServingStatus.NOT_SERVING);
            manager.initialize(["svc.v1.Foo"]);
            assert.strictEqual(manager.getStatus("process")?.status, ServingStatus.NOT_SERVING);
        });

        it("still drops an RPC service updated by update() when it is no longer mounted", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);
            manager.update(ServingStatus.SERVING, "svc.v1.Foo");
            manager.update(ServingStatus.SERVING);

            manager.initialize([]);

            assert.strictEqual(manager.getAllStatuses().size, 0);
        });
    });

    describe("initialize with components", () => {
        it("should preserve components registered before initialization", () => {
            manager.register("process");
            manager.initialize(["svc.v1.Foo"]);

            assert.strictEqual(manager.getStatus("process")?.status, ServingStatus.UNKNOWN);
            assert.strictEqual(manager.getStatus("svc.v1.Foo")?.status, ServingStatus.UNKNOWN);
            assert.strictEqual(manager.getAllStatuses().size, 2);
        });

        it("should preserve component status across re-initialization", () => {
            manager.register("process");
            manager.set("process", ServingStatus.SERVING);
            manager.initialize(["svc.v1.Foo"]);
            manager.initialize(["svc.v1.Bar"]);

            assert.strictEqual(manager.getStatus("process")?.status, ServingStatus.SERVING);
            assert.strictEqual(manager.getStatus("svc.v1.Foo"), undefined);
            assert.strictEqual(manager.getStatus("svc.v1.Bar")?.status, ServingStatus.UNKNOWN);
        });

        it("should remove stale services but never components", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);
            manager.register("process");
            manager.initialize(["svc.v1.Foo"]);

            assert.strictEqual(manager.getStatus("svc.v1.Bar"), undefined);
            assert.ok(manager.getAllStatuses().has("process"));
            assert.ok(manager.getAllStatuses().has("svc.v1.Foo"));
        });
    });

    describe("aggregate health with components", () => {
        it("NOT_SERVING component fails aggregate health", () => {
            manager.set("process", ServingStatus.SERVING);
            manager.set("amqp", ServingStatus.NOT_SERVING);

            assert.strictEqual(manager.areAllHealthy(), false);
        });

        it("all SERVING components and services are healthy", () => {
            manager.initialize(["svc.v1.Foo"]);
            manager.update(ServingStatus.SERVING, "svc.v1.Foo");
            manager.set("process", ServingStatus.SERVING);

            assert.strictEqual(manager.areAllHealthy(), true);
        });
    });
});
