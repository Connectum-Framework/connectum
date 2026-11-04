import assert from "node:assert";
import { describe, it } from "node:test";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { createHttpHealthHandler } from "../../src/httpHandler.ts";

describe("createHttpHealthHandler() paths", () => {
    const manager = createHealthcheckManager();

    it("throws RangeError for an empty list instead of building a handler that handles nothing", () => {
        assert.throws(
            () => createHttpHealthHandler(manager, []),
            (err: unknown) => err instanceof RangeError && /createHttpHealthHandler\(\)/.test(err.message) && /healthPaths/.test(err.message),
        );
    });

    for (const [label, value, expected] of [
        ["a non-array", "/healthz", TypeError],
        ["null", null, TypeError],
        ["a non-string entry", [1], TypeError],
        ["an entry without a leading slash", ["healthz"], TypeError],
        ["an entry with a query", ["/healthz?x=1"], TypeError],
        ["an entry with a fragment", ["/healthz#top"], TypeError],
    ] as Array<[string, unknown, ErrorConstructor]>) {
        it(`throws ${expected.name} naming healthPaths for ${label}`, () => {
            assert.throws(
                () => createHttpHealthHandler(manager, value as string[]),
                (err: unknown) => err instanceof expected && /healthPaths/.test(err.message),
            );
        });
    }

    it("uses the default paths for an omitted or undefined list and the given paths otherwise", () => {
        const request = (url: string) => ({ url, headers: {} }) as never;
        const response = () => ({ statusCode: 0, setHeader() {}, end() {} }) as never;

        assert.strictEqual(createHttpHealthHandler(manager)(request("/healthz"), response()), true);
        assert.strictEqual(createHttpHealthHandler(manager, undefined)(request("/readyz"), response()), true);
        assert.strictEqual(createHttpHealthHandler(manager, ["/live"])(request("/live"), response()), true);
        assert.strictEqual(createHttpHealthHandler(manager, ["/live"])(request("/healthz"), response()), false);
    });
});
