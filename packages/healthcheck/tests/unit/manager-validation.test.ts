import assert from "node:assert";
import { describe, it } from "node:test";
import { HealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

/** Values that are not a status: the wrong type, or a number outside 0 to 3. */
const WRONG_TYPE: Array<[string, unknown]> = [
    ["a status name", "SERVING"],
    ["a numeric string", "1"],
    ["a boolean", true],
    ["null", null],
    ["undefined", undefined],
    ["an object", {}],
    ["a bigint", 1n],
];
const WRONG_NUMBER: Array<[string, number]> = [
    ["a number above the enum", 4],
    ["a large number", 99],
    ["a negative number", -1],
    ["a fraction", 1.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a number past int32", 4_294_967_296],
];

describe("HealthcheckManager status validation", () => {
    for (const [label, value] of WRONG_TYPE) {
        it(`update() throws TypeError for ${label} and changes nothing`, () => {
            const manager = new HealthcheckManager();
            manager.set("db", ServingStatus.SERVING);

            assert.throws(() => manager.update(value as ServingStatus), (err: unknown) => err instanceof TypeError && /status/.test(err.message));
            assert.throws(() => manager.update(value as ServingStatus, "db"), TypeError);

            assert.strictEqual(manager.getStatus("db")?.status, ServingStatus.SERVING);
        });

        it(`set() throws TypeError for ${label} and registers nothing`, () => {
            const manager = new HealthcheckManager();

            assert.throws(() => manager.set("db", value as ServingStatus), (err: unknown) => err instanceof TypeError && /status/.test(err.message));

            assert.strictEqual(manager.getStatus("db"), undefined);
        });
    }

    for (const [label, value] of WRONG_TYPE.filter(([, v]) => v !== undefined)) {
        it(`register() throws TypeError for an initial status of ${label}`, () => {
            const manager = new HealthcheckManager();

            assert.throws(() => manager.register("db", value as ServingStatus), TypeError);

            assert.strictEqual(manager.getStatus("db"), undefined);
        });
    }

    for (const [label, value] of WRONG_NUMBER) {
        it(`update(), set() and register() throw RangeError for ${label}`, () => {
            const manager = new HealthcheckManager();
            manager.set("db", ServingStatus.SERVING);

            assert.throws(() => manager.update(value as ServingStatus), (err: unknown) => err instanceof RangeError && /status/.test(err.message));
            assert.throws(() => manager.update(value as ServingStatus, "db"), RangeError);
            assert.throws(() => manager.set("db", value as ServingStatus), RangeError);
            assert.throws(() => manager.register("other", value as ServingStatus), RangeError);

            assert.strictEqual(manager.getStatus("db")?.status, ServingStatus.SERVING);
            assert.strictEqual(manager.getStatus("other"), undefined);
        });
    }

    it("names the received value in the message", () => {
        const manager = new HealthcheckManager();

        assert.throws(() => manager.set("db", 99 as ServingStatus), /99/);
        assert.throws(() => manager.set("db", "SERVING" as unknown as ServingStatus), /SERVING/);
    });

    it("accepts all four ServingStatus values in all three methods", () => {
        const manager = new HealthcheckManager();
        for (const status of [ServingStatus.UNKNOWN, ServingStatus.SERVING, ServingStatus.NOT_SERVING, ServingStatus.SERVICE_UNKNOWN]) {
            manager.set("db", status);
            assert.strictEqual(manager.getStatus("db")?.status, status);
            manager.update(status, "db");
            assert.strictEqual(manager.getStatus("db")?.status, status);
            manager.update(status);
            assert.strictEqual(manager.getStatus("db")?.status, status);
            manager.unregister("db");
            manager.register("db", status);
            assert.strictEqual(manager.getStatus("db")?.status, status);
            manager.unregister("db");
        }
    });

    it("register() without a status still means UNKNOWN", () => {
        const manager = new HealthcheckManager();

        manager.register("db");

        assert.strictEqual(manager.getStatus("db")?.status, ServingStatus.UNKNOWN);
    });
});

describe("HealthcheckManager component name validation", () => {
    for (const [label, value] of [
        ["a number", 123],
        ["null", null],
        ["undefined", undefined],
        ["a symbol", Symbol("db")],
        ["an object", {}],
    ] as Array<[string, unknown]>) {
        it(`register() and set() throw TypeError naming the argument for ${label}`, () => {
            const manager = new HealthcheckManager();

            assert.throws(() => manager.register(value as string), (err: unknown) => err instanceof TypeError && /component/.test(err.message));
            assert.throws(() => manager.set(value as string, ServingStatus.SERVING), (err: unknown) => err instanceof TypeError && /component/.test(err.message));
            assert.strictEqual(manager.getAllStatuses().size, 0);
        });
    }

    it("update() throws TypeError for a service that is not a string", () => {
        const manager = new HealthcheckManager();
        manager.set("db", ServingStatus.SERVING);

        assert.throws(() => manager.update(ServingStatus.NOT_SERVING, 5 as unknown as string), (err: unknown) => err instanceof TypeError && /service/.test(err.message));

        assert.strictEqual(manager.getStatus("db")?.status, ServingStatus.SERVING);
    });

    it("keeps the Error for an empty name and a dotted name", () => {
        const manager = new HealthcheckManager();

        assert.throws(() => manager.set("", ServingStatus.SERVING), /must not be empty/);
        assert.throws(() => manager.register("a.b"), /must not contain dots/);
    });
});
