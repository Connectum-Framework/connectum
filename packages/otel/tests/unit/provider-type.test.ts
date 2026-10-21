/**
 * Compile-time contract of the public `OtelProvider` type: it is exported from
 * the package root and from the `provider` subpath as the same type, and it is
 * what `getProvider()` returns, so callers can store or pass the provider on
 * without spelling out `ReturnType<typeof getProvider>`. The checks are made by
 * the type checker, so a removed export or a changed shape fails `typecheck`;
 * the runtime assertions only show that the value carries the declared members.
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { OtelProvider as OtelProviderFromRoot } from "../../src/index.ts";
import { getProvider as getProviderFromRoot, shutdownProvider } from "../../src/index.ts";
import type { OtelProvider as OtelProviderFromSubpath } from "../../src/provider.ts";
import { getProvider } from "../../src/provider.ts";

/** Resolves to `true` only when both types are mutually identical. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Each constant below fails to compile when its claim stops holding. */
const sameTypeFromBothEntries: Equal<OtelProviderFromRoot, OtelProviderFromSubpath> = true;
const getProviderReturnsIt: Equal<ReturnType<typeof getProvider>, OtelProviderFromRoot> = true;
const rootGetProviderReturnsIt: Equal<ReturnType<typeof getProviderFromRoot>, OtelProviderFromSubpath> = true;
const members: Equal<keyof OtelProviderFromRoot, "tracer" | "meter" | "logger" | "shutdown"> = true;

describe("OtelProvider type", () => {
    afterEach(async () => {
        await shutdownProvider();
    });

    it("is exported from the root and the provider subpath and is the type getProvider() returns", () => {
        const provider: OtelProviderFromRoot = getProvider();
        const same: OtelProviderFromSubpath = provider;

        assert.strictEqual(same, getProviderFromRoot(), "both entries hand out the one provider of the process");
        assert.strictEqual(typeof provider.tracer.startSpan, "function");
        assert.strictEqual(typeof provider.meter.createCounter, "function");
        assert.strictEqual(typeof provider.logger.emit, "function");
        assert.strictEqual(typeof provider.shutdown, "function");
        assert.deepStrictEqual([sameTypeFromBothEntries, getProviderReturnsIt, rootGetProviderReturnsIt, members], [true, true, true, true]);
    });

    // The package keeps exactly one provider per process; a public constructor would let a caller
    // build a second one that competes for OpenTelemetry's global registration.
    it("has no public constructor: the implementation class is exported from neither entry", async () => {
        const root: Record<string, unknown> = await import("../../src/index.ts");
        const subpath: Record<string, unknown> = await import("../../src/provider.ts");

        for (const [entry, exports] of [
            ["the root", root],
            ["the provider subpath", subpath],
        ] as const) {
            assert.strictEqual("OtelProviderImpl" in exports, false, `${entry} must not export the provider implementation class`);
        }
    });
});
