import assert from "node:assert";
import { describe, it } from "node:test";
import { HealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

describe("HealthcheckManager.subscribe", () => {
    it("calls the listener after every mutation that changes the registry", () => {
        const manager = new HealthcheckManager();
        let calls = 0;
        manager.subscribe(() => calls++);

        manager.register("a");
        manager.set("a", ServingStatus.SERVING);
        manager.update(ServingStatus.NOT_SERVING, "a");
        manager.update(ServingStatus.SERVING);
        manager.initialize(["svc.v1.S"]);
        manager.unregister("a");
        manager.clear();

        assert.strictEqual(calls, 7);
    });

    it("calls the listener after the new state is in place", () => {
        const manager = new HealthcheckManager();
        const seen: Array<ServingStatus | undefined> = [];
        manager.subscribe(() => seen.push(manager.getStatus("a")?.status));

        manager.set("a", ServingStatus.SERVING);
        manager.set("a", ServingStatus.NOT_SERVING);

        assert.deepStrictEqual(seen, [ServingStatus.SERVING, ServingStatus.NOT_SERVING]);
    });

    it("does not call the listener for a refused mutation", () => {
        const manager = new HealthcheckManager();
        let calls = 0;
        manager.subscribe(() => calls++);

        assert.throws(() => manager.set("a", 99 as ServingStatus));
        assert.throws(() => manager.update(ServingStatus.SERVING, "missing"));

        assert.strictEqual(calls, 0);
    });

    it("stops calling a listener after it unsubscribes, and unsubscribing twice is harmless", () => {
        const manager = new HealthcheckManager();
        let calls = 0;
        const unsubscribe = manager.subscribe(() => calls++);

        manager.set("a", ServingStatus.SERVING);
        unsubscribe();
        unsubscribe();
        manager.set("a", ServingStatus.NOT_SERVING);

        assert.strictEqual(calls, 1);
    });

    it("lets a listener unsubscribe itself while the others still run", () => {
        const manager = new HealthcheckManager();
        const order: string[] = [];
        const unsubscribeFirst = manager.subscribe(() => {
            order.push("first");
            unsubscribeFirst();
        });
        manager.subscribe(() => order.push("second"));

        manager.set("a", ServingStatus.SERVING);
        manager.set("a", ServingStatus.NOT_SERVING);

        assert.deepStrictEqual(order, ["first", "second", "second"]);
    });

    it("runs every listener when one throws and rethrows the first error to the caller", () => {
        const manager = new HealthcheckManager();
        const failure = new Error("listener failed");
        let reached = false;
        manager.subscribe(() => {
            throw failure;
        });
        manager.subscribe(() => {
            reached = true;
        });

        assert.throws(() => manager.set("a", ServingStatus.SERVING), (err: unknown) => err === failure);

        assert.strictEqual(reached, true);
        assert.strictEqual(manager.getStatus("a")?.status, ServingStatus.SERVING, "the mutation itself is not rolled back");
    });

    it("throws TypeError when the listener is not a function", () => {
        const manager = new HealthcheckManager();

        assert.throws(() => manager.subscribe("x" as unknown as () => void), (err: unknown) => err instanceof TypeError && /listener/.test(err.message));
    });
});
