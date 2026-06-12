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

        it("should not throw when updating all services on empty manager", () => {
            const emptyManager = new HealthcheckManager();
            // Should not throw, just no-op
            emptyManager.update(ServingStatus.SERVING);
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
        it("should return a copy of all statuses", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);
            const statuses = manager.getAllStatuses();

            assert.strictEqual(statuses.size, 2);
            assert.ok(statuses.has("svc.v1.Foo"));
            assert.ok(statuses.has("svc.v1.Bar"));

            // Verify it's a copy (modifying the returned map shouldn't affect the manager)
            statuses.clear();
            assert.strictEqual(manager.getAllStatuses().size, 2);
        });
    });

    describe("areAllHealthy", () => {
        it("should return false when no services registered", () => {
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
        it("should preserve existing service status when re-initialized with overlapping names", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);
            manager.update(ServingStatus.SERVING, "svc.v1.Foo");

            // Re-initialize with overlapping "Foo" and new "Baz"
            manager.initialize(["svc.v1.Foo", "svc.v1.Baz"]);

            // Foo should retain SERVING status
            assert.strictEqual(
                manager.getStatus("svc.v1.Foo")?.status,
                ServingStatus.SERVING,
                "Overlapping service should retain its current status",
            );

            // Baz is new, should be UNKNOWN
            assert.strictEqual(
                manager.getStatus("svc.v1.Baz")?.status,
                ServingStatus.UNKNOWN,
                "New service should start as UNKNOWN",
            );

            // Bar was not in the new list, should be gone
            assert.strictEqual(
                manager.getStatus("svc.v1.Bar"),
                undefined,
                "Service not in new list should be removed",
            );
        });

        it("should clear all services when initialized with empty array", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Bar"]);
            assert.strictEqual(manager.getAllStatuses().size, 2);

            manager.initialize([]);

            assert.strictEqual(manager.getAllStatuses().size, 0);
            assert.strictEqual(manager.getStatus("svc.v1.Foo"), undefined);
            assert.strictEqual(manager.getStatus("svc.v1.Bar"), undefined);
        });

        it("should deduplicate when initialized with duplicate names", () => {
            manager.initialize(["svc.v1.Foo", "svc.v1.Foo", "svc.v1.Foo"]);

            assert.strictEqual(manager.getAllStatuses().size, 1);
            assert.strictEqual(manager.getStatus("svc.v1.Foo")?.status, ServingStatus.UNKNOWN);
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

        it("should reject empty component name", () => {
            assert.throws(() => manager.register(""), /must not be empty/);
        });

        it("should reject dotted component name", () => {
            assert.throws(() => manager.register("acme.process"), /must not contain dots/);
        });
    });

    describe("set (upsert)", () => {
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

        it("should reject empty and dotted names", () => {
            assert.throws(() => manager.set("", ServingStatus.SERVING), /must not be empty/);
            assert.throws(() => manager.set("a.b", ServingStatus.SERVING), /must not contain dots/);
        });
    });

    describe("unregister", () => {
        it("should remove a component", () => {
            manager.register("process");
            manager.unregister("process");

            assert.strictEqual(manager.getStatus("process"), undefined);
        });

        it("should be a no-op for unknown names", () => {
            manager.unregister("ghost");
        });

        it("should reject unregistering an RPC service", () => {
            manager.initialize(["svc.v1.Foo"]);

            assert.throws(() => manager.unregister("svc.v1.Foo"), /registered RPC service/);
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

        it("empty registry stays unhealthy", () => {
            assert.strictEqual(manager.areAllHealthy(), false);
        });
    });
});
