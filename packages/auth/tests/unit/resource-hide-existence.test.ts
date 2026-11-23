/**
 * Existence hiding: after a denial, a second check decides between PermissionDenied (the caller may
 * know the object exists) and NotFound (the caller may not).
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { run } from "../helpers/resource-gate-harness.ts";

const update = { input: "DocRequest", auth: { resources: [{ action: "update", idField: "id", type: "doc" }] } } as const;

/** Allow only the listed actions. */
const allowing =
    (...actions: string[]) =>
    (input: { action: string }) =>
        actions.includes(input.action) ? "allow" : "deny";

describe("hideExistence", () => {
    it("answers NotFound when the caller is denied both the action and the visibility check", async () => {
        const result = await run({ method: update, interceptor: { hideExistence: { action: "read" } }, authorizer: allowing() });
        assert.strictEqual(result.code, Code.NotFound);
        assert.deepStrictEqual(
            result.asked.map((asked) => asked.action),
            ["update", "read"],
        );
        assert.strictEqual(result.handled, 0);
    });

    it("answers PermissionDenied when the caller may see the object", async () => {
        const result = await run({ method: update, interceptor: { hideExistence: { action: "read" } }, authorizer: allowing("read") });
        assert.strictEqual(result.code, Code.PermissionDenied);
        assert.strictEqual(result.asked.length, 2);
    });

    it("does not run the visibility check when the first check allows", async () => {
        const result = await run({ method: update, interceptor: { hideExistence: { action: "read" } }, authorizer: allowing("update") });
        assert.strictEqual(result.code, undefined);
        assert.strictEqual(result.asked.length, 1);
    });

    it("keeps the code of a ConnectError thrown by the visibility check", async () => {
        const result = await run({
            method: update,
            interceptor: { hideExistence: { action: "read" } },
            authorizer: (input) => {
                if (input.action === "read") {
                    throw new ConnectError("engine unreachable", Code.Unavailable);
                }
                return "deny";
            },
        });
        assert.strictEqual(result.code, Code.Unavailable);
    });

    it("turns any other exception of the visibility check into Internal", async () => {
        const result = await run({
            method: update,
            interceptor: { hideExistence: { action: "read" } },
            authorizer: (input) => {
                if (input.action === "read") {
                    throw new Error("secret detail");
                }
                return "deny";
            },
        });
        assert.strictEqual(result.code, Code.Internal);
        assert.ok(!(result.error as ConnectError).rawMessage.includes("secret"));
    });

    it("reads only the literal allow of the visibility check as visible", async () => {
        const result = await run({ method: update, interceptor: { hideExistence: { action: "read" } }, authorizer: (input) => (input.action === "read" ? true : "deny") });
        assert.strictEqual(result.code, Code.NotFound);
    });

    describe("per type", () => {
        const byType = { organization: "is_member" };
        const method = { input: "DocRequest", auth: { resources: [{ action: "update", idField: "id", type: "organization" }] } } as const;

        it("checks the action named for the resource type, not the default", async () => {
            const result = await run({ method, interceptor: { hideExistence: { action: "read", byType } }, authorizer: allowing() });
            assert.strictEqual(result.code, Code.NotFound);
            assert.deepStrictEqual(
                result.asked.map((asked) => asked.action),
                ["update", "is_member"],
            );
        });

        it("uses the default action for a type not named in byType", async () => {
            const result = await run({ method: update, interceptor: { hideExistence: { action: "read", byType } }, authorizer: allowing() });
            assert.deepStrictEqual(
                result.asked.map((asked) => asked.action),
                ["update", "read"],
            );
        });

        it("does not read a type name from the prototype of byType", async () => {
            const constructorType = { input: "DocRequest", auth: { resources: [{ action: "update", idField: "id", type: "constructor" }] } } as const;
            const result = await run({ method: constructorType, interceptor: { hideExistence: { action: "read", byType } }, authorizer: allowing() });
            assert.deepStrictEqual(
                result.asked.map((asked) => asked.action),
                ["update", "read"],
            );
        });
    });

    it("without hideExistence a denial is PermissionDenied and asks once", async () => {
        const result = await run({ method: update, authorizer: allowing() });
        assert.strictEqual(result.code, Code.PermissionDenied);
        assert.strictEqual(result.asked.length, 1);
    });
});
