/**
 * Compile-time contract of the public `EventAdapterFactory` type: the package
 * entry exports it, and it is a zero-argument function returning an
 * `EventAdapter`. Callers rely on both to wire one adapter per consumer and to
 * substitute test doubles. The checks are made by the type checker, so a removed
 * export or a changed shape fails `typecheck`; the runtime assertion only shows
 * that a factory of this type produces a working adapter.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EventAdapter, EventAdapterFactory } from "../../src/index.ts";
import { MemoryAdapter } from "../../src/index.ts";

/** Resolves to `true` only when both types are mutually identical. */
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

/** Each constant below fails to compile when its claim stops holding. */
const takesNoArguments: Equal<Parameters<EventAdapterFactory>, []> = true;
const returnsAnAdapter: Equal<ReturnType<EventAdapterFactory>, EventAdapter> = true;
const isAPlainFactory: Equal<EventAdapterFactory, () => EventAdapter> = true;

describe("EventAdapterFactory type", () => {
    it("is exported from the package entry as a zero-argument factory of an EventAdapter", () => {
        const factory: EventAdapterFactory = () => MemoryAdapter();

        assert.equal(factory().name, "memory");
        assert.deepEqual([takesNoArguments, returnsAnAdapter, isAPlainFactory], [true, true, true]);
    });
});
