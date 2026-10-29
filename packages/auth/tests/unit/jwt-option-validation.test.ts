/**
 * Expected-claim options of the JWT interceptor are checked when it is created.
 *
 * An empty string for `issuer` or `audience` and a `maxTokenAge` of 0 used to be skipped as
 * falsy, which switched the check off. A present value must be usable; an absent one still
 * means "do not check".
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import type { JwtAuthInterceptorOptions } from "../../src/types.ts";

const create = (extra: Partial<JwtAuthInterceptorOptions>) => createJwtAuthInterceptor({ secret: TEST_JWT_SECRET, ...extra });

describe("createJwtAuthInterceptor: expected claims", () => {
    for (const option of ["issuer", "audience"] as const) {
        describe(option, () => {
            for (const value of ["", ["a", ""], [""], [1], [null], 5, null, false, {}]) {
                it(`refuses ${JSON.stringify(value)}`, () => {
                    assert.throws(
                        () => create({ [option]: value } as never),
                        (err: unknown) => {
                            assert.ok(err instanceof TypeError);
                            assert.match(err.message, new RegExp(`createJwtAuthInterceptor ${option} must be a non-empty string or an array of non-empty strings`));
                            return true;
                        },
                    );
                });
            }

            it("accepts a non-empty string, an array of non-empty strings, an empty array and an omitted option", () => {
                create({ [option]: "x" });
                create({ [option]: ["x", "y"] });
                create({ [option]: [] });
                create({ [option]: undefined });
                create({});
            });
        });
    }
});

describe("createJwtAuthInterceptor: maxTokenAge", () => {
    for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, "", "   "]) {
        it(`refuses ${String(value) === "" ? "an empty string" : JSON.stringify(value) ?? String(value)}`, () => {
            assert.throws(
                () => create({ maxTokenAge: value }),
                (err: unknown) => {
                    assert.ok(err instanceof RangeError);
                    assert.match(err.message, /createJwtAuthInterceptor maxTokenAge must/);
                    return true;
                },
            );
        });
    }

    for (const value of [true, null, {}, []]) {
        it(`refuses the non-number, non-string ${JSON.stringify(value)}`, () => {
            assert.throws(
                () => create({ maxTokenAge: value as never }),
                (err: unknown) => err instanceof TypeError && /maxTokenAge must be a number of seconds or a duration string/.test(err.message),
            );
        });
    }

    it("accepts a positive number, a duration string and an omitted option", () => {
        create({ maxTokenAge: 60 });
        create({ maxTokenAge: 0.5 });
        create({ maxTokenAge: "2h" });
        create({ maxTokenAge: undefined });
    });
});
