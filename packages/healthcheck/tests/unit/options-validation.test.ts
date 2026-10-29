import assert from "node:assert";
import { describe, it } from "node:test";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";

describe("Healthcheck() options object", () => {
    for (const [label, value] of [
        ["null", null],
        ["a string", "x"],
        ["a number", 5],
        ["an array", []],
    ] as Array<[string, unknown]>) {
        it(`throws TypeError naming options for ${label}`, () => {
            assert.throws(
                () => Healthcheck(value as never),
                (err: unknown) => err instanceof TypeError && /Healthcheck\(\)/.test(err.message) && /options/.test(err.message),
            );
        });
    }

    it("treats no argument, undefined and an empty object alike", () => {
        assert.strictEqual(Healthcheck().name, "healthcheck");
        assert.strictEqual(Healthcheck(undefined).name, "healthcheck");
        assert.strictEqual(Healthcheck({}).name, "healthcheck");
    });
});

describe("Healthcheck() manager", () => {
    for (const [label, value] of [
        ["a string", "x"],
        ["null", null],
        ["an empty object", {}],
        ["an object missing methods", { initialize() {}, getStatus() {} }],
        ["a number", 5],
    ] as Array<[string, unknown]>) {
        it(`throws TypeError naming manager for ${label}`, () => {
            assert.throws(
                () => Healthcheck({ manager: value as never }),
                (err: unknown) => err instanceof TypeError && /Healthcheck\(\)/.test(err.message) && /manager/.test(err.message),
            );
        });
    }

    it("accepts a manager and an explicit undefined (the default singleton)", () => {
        assert.strictEqual(Healthcheck({ manager: createHealthcheckManager() }).name, "healthcheck");
        assert.strictEqual(Healthcheck({ manager: undefined } as never).name, "healthcheck");
    });
});

describe("Healthcheck() httpEnabled", () => {
    for (const [label, value] of [
        ["a string", "yes"],
        ["a number", 1],
        ["null", null],
        ["an object", {}],
    ] as Array<[string, unknown]>) {
        it(`throws TypeError naming httpEnabled for ${label}`, () => {
            assert.throws(
                () => Healthcheck({ httpEnabled: value as boolean }),
                (err: unknown) => err instanceof TypeError && /Healthcheck\(\)/.test(err.message) && /httpEnabled/.test(err.message),
            );
        });
    }

    it("accepts true, false and undefined", () => {
        assert.ok(Healthcheck({ httpEnabled: true }).httpHandler);
        assert.strictEqual(Healthcheck({ httpEnabled: false }).httpHandler, undefined);
        assert.strictEqual(Healthcheck({ httpEnabled: undefined } as never).httpHandler, undefined);
    });
});
