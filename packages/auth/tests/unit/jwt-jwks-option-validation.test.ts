/**
 * The `jwks` options of the JWT interceptor are checked when it is created.
 *
 * They are handed to jose's remote key set, which would accept some values that cannot work (a
 * timeout of 0 aborts every fetch) and would ignore a misspelled name, leaving the default window
 * after a key rotation in place without a word. A present value must be usable.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createJwtAuthInterceptor } from "../../src/jwt-auth-interceptor.ts";
import { TEST_JWT_SECRET } from "../../src/testing/test-jwt.ts";
import type { JwtAuthInterceptorOptions } from "../../src/types.ts";

const JWKS_URI = "http://127.0.0.1:1/jwks";
const create = (jwks: unknown, extra: Partial<JwtAuthInterceptorOptions> = {}) => createJwtAuthInterceptor({ jwksUri: JWKS_URI, jwks: jwks as never, ...extra });

/** Assert that creating the interceptor throws `kind` with a message that names the factory and `fragment`. */
function refuses(jwks: unknown, kind: typeof TypeError | typeof RangeError, fragment: RegExp, extra: Partial<JwtAuthInterceptorOptions> = {}) {
    assert.throws(
        () => create(jwks, extra),
        (err: unknown) => {
            assert.ok(err instanceof kind, `expected ${kind.name}, got ${String(err)}`);
            assert.match(err.message, /^@connectum\/auth: createJwtAuthInterceptor /);
            assert.match(err.message, fragment);
            return true;
        },
    );
}

describe("createJwtAuthInterceptor: jwks options", () => {
    it("accepts no jwks, an empty object and every option in range", () => {
        create(undefined);
        create({});
        create({ cooldownDuration: 0, cacheMaxAge: 0, timeoutDuration: 1 });
        create({ timeoutDuration: 2_147_483_647 });
        create({ cooldownDuration: 1500, cacheMaxAge: Number.POSITIVE_INFINITY, timeoutDuration: 2000 });
        create({ cooldownDuration: undefined, cacheMaxAge: undefined, timeoutDuration: undefined });
    });

    for (const value of [null, "30000", 5, true, [], [{ cooldownDuration: 0 }]]) {
        it(`refuses ${JSON.stringify(value)} as the jwks object`, () => {
            refuses(value, TypeError, /jwks must be an object with cooldownDuration, cacheMaxAge, timeoutDuration/);
        });
    }

    it("refuses an option name jose does not read, so a typo does not leave the default in place", () => {
        refuses({ cooldown: 0 }, TypeError, /jwks\.cooldown is not a known option; use cooldownDuration, cacheMaxAge, timeoutDuration/);
        refuses({ cooldownDuration: 0, headers: {} }, TypeError, /jwks\.headers is not a known option/);
    });

    it("refuses jwks without jwksUri, for every other key source, since the settings would change nothing", () => {
        const options = { jwksUri: undefined };
        refuses({ cooldownDuration: 0 }, TypeError, /jwks only applies to a remote key set; set jwksUri or drop jwks/, { ...options, secret: TEST_JWT_SECRET });
        refuses({ cooldownDuration: 0 }, TypeError, /jwks only applies to a remote key set/, { ...options, publicKey: {} as CryptoKey });
    });

    for (const name of ["cooldownDuration", "cacheMaxAge", "timeoutDuration"] as const) {
        for (const value of ["1000", null, true, {}, Number.NaN]) {
            it(`refuses ${String(JSON.stringify(value) ?? value)} for ${name}`, () => {
                refuses({ [name]: value }, TypeError, new RegExp(`jwks\\.${name} must be a number of milliseconds`));
            });
        }
    }

    for (const value of [-1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        it(`refuses ${value} for cooldownDuration`, () => {
            refuses({ cooldownDuration: value }, RangeError, /jwks\.cooldownDuration must be a finite number of milliseconds, 0 or more/);
        });
    }

    for (const value of [-1, Number.NEGATIVE_INFINITY]) {
        it(`refuses ${value} for cacheMaxAge`, () => {
            refuses({ cacheMaxAge: value }, RangeError, /jwks\.cacheMaxAge must be a number of milliseconds, 0 or more/);
        });
    }

    for (const value of [0, -5, 1.5, Number.POSITIVE_INFINITY, 2_147_483_648, 4_294_967_296]) {
        it(`refuses ${value} for timeoutDuration`, () => {
            refuses({ timeoutDuration: value }, RangeError, /jwks\.timeoutDuration must be a whole number of milliseconds from 1 to 2147483647/);
        });
    }
});
