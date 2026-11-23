/**
 * A method that declares only a resource rule must reach the authorizer under `defaultPolicy: "deny"`.
 *
 * Before the resource gate existed the method-level decision ended at the default policy, so a
 * method with nothing but `resources` was refused before any per-object check could run, and the
 * authorizer never saw the request message.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { authContextStorage } from "../../src/context.ts";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import type { AuthContext } from "../../src/types.ts";
import { createProtoMockRequest } from "../helpers/proto-test-helpers.ts";
import { buildResourceService, messageOf } from "../helpers/resource-test-helpers.ts";

const caller: AuthContext = { subject: "user-1", roles: [], scopes: [], claims: {}, type: "test" };

describe("resource rule as the only requirement", () => {
    it("runs the handler after the authorizer allowed the object, under defaultPolicy deny", async () => {
        const { service, methods } = buildResourceService({
            Read: { input: "DocRequest", auth: { resources: [{ action: "read", idField: "id", type: "doc" }] } },
        });
        const method = methods.Read as NonNullable<typeof methods.Read>;
        const message = messageOf(method, { id: "d1" });
        const seen: Array<{ subject: string; action: string; resource: { type: string; id: string }; message: unknown }> = [];

        const interceptor = createProtoAuthzInterceptor({
            defaultPolicy: "deny",
            resourceAuthorizer: {
                check: (input) => {
                    seen.push({ subject: input.subject.subject, action: input.action, resource: input.resource, message: input.context.message });
                    return "allow";
                },
            },
        });
        let handled = 0;
        let handledMessage: unknown;
        const handler = interceptor((async (req: { message: unknown }) => {
            handled += 1;
            handledMessage = req.message;
            return { message: {} };
        }) as never);

        await authContextStorage.run(caller, () => handler({ ...createProtoMockRequest(service, method), message } as never));

        assert.strictEqual(handled, 1, "the handler must run");
        assert.deepStrictEqual(
            seen.map(({ message: _message, ...rest }) => rest),
            [{ subject: "user-1", action: "read", resource: { type: "doc", id: "d1" } }],
        );
        assert.strictEqual(seen[0]?.message, message, "the authorizer must receive the request message");
        assert.strictEqual(handledMessage, message, "the handler must receive the very message the authorizer read");
    });
});
