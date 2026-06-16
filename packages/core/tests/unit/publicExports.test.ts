/**
 * Public-API surface regression tests.
 *
 * Const-object enums (ADR-001) carry BOTH a runtime value and a type. They must
 * be re-exported from the package barrel (`src/index.ts`) as VALUES — a
 * type-only re-export (`export type { X }`) erases the runtime const, leaving
 * the symbol `undefined` for every consumer while the `.d.ts` still advertises
 * it as a value. (Regression: `EffectiveTransport` / `TransportValidationMode`
 * were re-exported as types and shipped `undefined` in 1.0.0-rc.) These imports
 * come from the BARREL on purpose — importing the source module directly would
 * not reproduce the erasure.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { EffectiveTransport, ServerState, TransportValidationMode } from "../../src/index.ts";

describe("public exports — const-object enums are runtime values from the barrel", () => {
    it("TransportValidationMode is a runtime object with its documented members", () => {
        assert.strictEqual(typeof TransportValidationMode, "object");
        assert.deepStrictEqual({ ...TransportValidationMode }, { ERROR: "error", WARN: "warn", OFF: "off" });
    });

    it("EffectiveTransport is a runtime object with its documented members", () => {
        assert.strictEqual(typeof EffectiveTransport, "object");
        assert.deepStrictEqual({ ...EffectiveTransport }, {
            PLAINTEXT_H1: "plaintext-h1",
            H2C: "h2c",
            TLS_H1_NEGOTIABLE: "tls-h1-negotiable",
            TLS_H2_ONLY: "tls-h2-only",
        });
    });

    it("ServerState (existing const-enum) stays a runtime value too", () => {
        assert.strictEqual(typeof ServerState, "object");
    });
});
