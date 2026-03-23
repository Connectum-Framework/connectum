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
