/**
 * What the resource gate asks the authorizer, how it reads the answer, and what the caller sees.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import type { ResourceAuthorizer, ResourceCheck } from "../../src/types.ts";
import { caller, READ_DOC, run } from "../helpers/resource-gate-harness.ts";
import { buildResourceService } from "../helpers/resource-test-helpers.ts";

const doc = { input: "DocRequest", auth: { resources: READ_DOC } } as const;

describe("what the authorizer is asked", () => {
    it("receives the subject, action, resource, service, method and the request message", async () => {
        const result = await run({ method: doc, request: { id: "d7" } });
        const [asked] = result.asked as [ResourceCheck];
        assert.strictEqual(asked.subject, caller);
        assert.strictEqual(asked.action, "read");
        assert.deepStrictEqual(asked.resource, { type: "doc", id: "d7" });
        assert.strictEqual(asked.context.service, "test.resource.v1.ResourceService");
        assert.strictEqual(asked.context.method, "Call");
        assert.strictEqual(asked.context.message, result.handledMessage, "the authorizer and the handler see the same message object");
    });

    it("reads the type from the request when the rule names a type field", async () => {
        const result = await run({
            method: {
                input: "MoveRequest",
                auth: { resources: [{ action: "create_child", idField: "target.id", typeField: "target.type", types: ["project", "task"] }] },
            },
            request: { target: { type: "project", id: "p1" } },
        });
        assert.strictEqual(result.code, undefined);
        assert.deepStrictEqual(result.asked[0]?.resource, { type: "project", id: "p1" });
    });

    it("is typed so that an authorizer cannot assign through the message", () => {
        const authorizer: ResourceAuthorizer = {
            check: ({ context }) => {
                // @ts-expect-error context.message is read-only
                context.message.$typeName = "other";
                return "deny";
            },
        };
        assert.strictEqual(typeof authorizer.check, "function");
    });
});

describe("only the literal allow allows", () => {
    for (const [label, answer] of [
        ["true", true],
        ['"ALLOW"', "ALLOW"],
        ["1", 1],
        ['"allow " (trailing space)', "allow "],
        ["an object", {}],
        ["undefined", undefined],
        ["null", null],
        ['"deny"', "deny"],
    ] as const) {
        it(`${label} denies with PermissionDenied`, async () => {
            const result = await run({ method: doc, authorizer: () => answer });
            assert.strictEqual(result.code, Code.PermissionDenied);
            assert.strictEqual(result.handled, 0);
        });
    }

    it('"allow" from an async authorizer allows', async () => {
        const result = await run({ method: doc, authorizer: async () => "allow" });
        assert.strictEqual(result.code, undefined);
        assert.strictEqual(result.handled, 1);
    });
});

describe("errors thrown by the authorizer", () => {
    it("keeps the code and message of a ConnectError", async () => {
        const result = await run({
            method: doc,
            authorizer: () => {
                throw new ConnectError("engine unreachable", Code.Unavailable);
            },
        });
        assert.strictEqual(result.code, Code.Unavailable);
        assert.strictEqual((result.error as ConnectError).rawMessage, "engine unreachable");
        assert.strictEqual(result.handled, 0);
    });

    it("keeps the code of a ConnectError rejected from an async authorizer", async () => {
        const result = await run({
            method: doc,
            authorizer: async () => {
                throw new ConnectError("slow", Code.DeadlineExceeded);
            },
        });
        assert.strictEqual(result.code, Code.DeadlineExceeded);
    });

    it("turns any other exception into Internal without its text, and logs it", async () => {
        const result = await run({
            method: doc,
            authorizer: () => {
                throw new Error("connect ECONNREFUSED 10.0.0.5:8081 password=hunter2");
            },
        });
        assert.strictEqual(result.code, Code.Internal);
        const error = result.error as ConnectError;
        assert.ok(!error.rawMessage.includes("hunter2") && !error.message.includes("ECONNREFUSED"), "the exception text must not reach the client");
        assert.strictEqual(result.logged.error.length, 1);
        assert.strictEqual(result.handled, 0);
    });

    it("turns a rejected non-Error value into Internal", async () => {
        const result = await run({
            method: doc,
            authorizer: async () => {
                throw "boom";
            },
        });
        assert.strictEqual(result.code, Code.Internal);
    });
});

describe("unreadable reference is invalid input", () => {
    it("an empty id fails with InvalidArgument naming the field, and the authorizer is not asked", async () => {
        const result = await run({ method: doc, request: { id: "" } });
        assert.strictEqual(result.code, Code.InvalidArgument);
        assert.match((result.error as ConnectError).rawMessage, /"id"/);
        assert.strictEqual(result.asked.length, 0);
        assert.strictEqual(result.handled, 0);
    });

    it("a type outside the allowed list fails with InvalidArgument", async () => {
        const result = await run({
            method: { input: "MoveRequest", auth: { resources: [{ action: "read", idField: "source.id", typeField: "source.type", types: ["project", "task"] }] } },
            request: { source: { type: "organization", id: "o1" } },
        });
        assert.strictEqual(result.code, Code.InvalidArgument);
        assert.match((result.error as ConnectError).rawMessage, /"source\.type"/);
        assert.strictEqual(result.asked.length, 0);
    });

    it("an unset parent message fails with InvalidArgument", async () => {
        const result = await run({ method: { input: "MoveRequest", auth: { resources: [{ action: "read", idField: "source.id", type: "doc" }] } }, request: {} });
        assert.strictEqual(result.code, Code.InvalidArgument);
        assert.strictEqual(result.asked.length, 0);
    });

    it("an unset oneof member fails with InvalidArgument", async () => {
        const result = await run({
            method: { input: "OneofRequest", auth: { resources: [{ action: "read", idField: "target.task_id", type: "task" }] } },
            request: { target: { kind: { case: "projectId", value: "p1" } } },
        });
        assert.strictEqual(result.code, Code.InvalidArgument);
        assert.strictEqual(result.asked.length, 0);
    });

    it("a set oneof member is checked against its value", async () => {
        const result = await run({
            method: { input: "OneofRequest", auth: { resources: [{ action: "read", idField: "target.task_id", type: "task" }] } },
            request: { target: { kind: { case: "taskId", value: "t9" } } },
        });
        assert.strictEqual(result.code, undefined);
        assert.deepStrictEqual(result.asked[0]?.resource, { type: "task", id: "t9" });
    });

    it("an invalid reference in a later rule stops the call before the first rule is asked", async () => {
        const result = await run({
            method: {
                input: "MoveRequest",
                auth: {
                    resources: [
                        { action: "update", idField: "source.id", type: "doc" },
                        { action: "create_child", idField: "target.id", type: "doc" },
                    ],
                },
            },
            request: { source: { id: "a" }, target: { id: "" } },
        });
        assert.strictEqual(result.code, Code.InvalidArgument);
        assert.strictEqual(result.asked.length, 0);
    });
});

describe("several resources are all required", () => {
    const move = {
        input: "MoveRequest",
        auth: {
            resources: [
                { action: "update", idField: "source.id", type: "task" },
                { action: "create_child", idField: "target.id", type: "project" },
            ],
        },
    } as const;

    it("runs the handler when every rule is allowed, asking in declaration order", async () => {
        const result = await run({ method: move, request: { source: { id: "t1" }, target: { id: "p1" } } });
        assert.strictEqual(result.code, undefined);
        assert.deepStrictEqual(
            result.asked.map((asked) => [asked.action, asked.resource.type, asked.resource.id]),
            [
                ["update", "task", "t1"],
                ["create_child", "project", "p1"],
            ],
        );
    });

    it("denies when the second rule is denied", async () => {
        const result = await run({ method: move, request: { source: { id: "t1" }, target: { id: "p1" } }, authorizer: (input) => (input.action === "create_child" ? "deny" : "allow") });
        assert.strictEqual(result.code, Code.PermissionDenied);
        assert.strictEqual(result.asked.length, 2);
        assert.strictEqual(result.handled, 0);
    });

    it("stops at the first denial", async () => {
        const result = await run({ method: move, request: { source: { id: "t1" }, target: { id: "p1" } }, authorizer: "deny" });
        assert.strictEqual(result.code, Code.PermissionDenied);
        assert.strictEqual(result.asked.length, 1);
    });
});

describe("no authorizer means deny", () => {
    it("fails with PermissionDenied, the handler does not run and a warning is logged once per method", async () => {
        const { service, methods } = buildResourceService({ Call: doc });
        const warnings: string[] = [];
        const interceptor = createProtoAuthzInterceptor({ defaultPolicy: "allow", logger: { warn: (text) => warnings.push(text), error: () => undefined } });
        let handled = 0;
        const handler = interceptor((async () => {
            handled += 1;
            return { message: {} };
        }) as never);
        const { authContextStorage } = await import("../../src/context.ts");
        const { createProtoMockRequest } = await import("../helpers/proto-test-helpers.ts");
        const call = async () => {
            try {
                await authContextStorage.run(caller, () => handler(createProtoMockRequest(service, methods.Call as never) as never));
            } catch (error) {
                return (error as ConnectError).code;
            }
            return undefined;
        };
        assert.strictEqual(await call(), Code.PermissionDenied);
        assert.strictEqual(await call(), Code.PermissionDenied);
        assert.strictEqual(handled, 0);
        assert.strictEqual(warnings.length, 1);
        assert.match(warnings[0] as string, /ResourceService\/Call/);
    });

    it("an unauthenticated call is still Unauthenticated", async () => {
        const result = await run({ method: doc, authorizer: null, subject: null });
        assert.strictEqual(result.code, Code.Unauthenticated);
    });
});

describe("option validation at creation", () => {
    it("refuses a resourceAuthorizer without check()", () => {
        assert.throws(() => createProtoAuthzInterceptor({ resourceAuthorizer: {} as never }), /resourceAuthorizer must be an object with a check\(\) function/);
    });

    it("refuses an empty hideExistence action", () => {
        assert.throws(() => createProtoAuthzInterceptor({ hideExistence: { action: "" } }), /hideExistence\.action must be a non-empty string/);
    });

    it("refuses an empty per-type visibility action", () => {
        assert.throws(() => createProtoAuthzInterceptor({ hideExistence: { action: "read", byType: { organization: "" } } }), /hideExistence\.byType\["organization"\]/);
    });
});
