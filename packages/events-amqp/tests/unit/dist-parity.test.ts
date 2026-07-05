/**
 * Pin the packaging invariant of the dual-entry build (#203): the /testing
 * subpath and the main barrel must share ONE copy of the error classes.
 * Without tsup `splitting: true` each bundle gets its own errors.ts copy and
 * `instanceof` breaks across the boundary in the PUBLISHED package — the
 * exact failure this test guards against. Runs against dist/ (built before
 * tests by the turbo pipeline).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("dist packaging parity (#203)", () => {
    it("errors thrown by dist/testing.js are instanceof the classes exported by dist/index.js", async () => {
        const testing = await import("../../dist/testing.js");
        const barrel = await import("../../dist/index.js");

        const fake = testing.FakeAmqpAdapter();
        await assert.rejects(
            () => fake.publish("x", new Uint8Array()),
            (err: unknown) => {
                assert.ok(err instanceof barrel.AmqpConnectionError, "instanceof must hold across the subpath boundary (shared chunk, not a duplicated class)");
                return true;
            },
        );
    });
});
