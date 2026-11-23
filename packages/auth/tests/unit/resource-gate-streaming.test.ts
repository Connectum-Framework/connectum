/**
 * The resource gate on a server-streaming method: the request is one message delivered as a
 * stream. The gate reads the first element to learn the resource, then gives the handler a stream
 * that yields that same element again.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import { authContextStorage } from "../../src/context.ts";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import type { ResourceCheck, ResourceDecision } from "../../src/types.ts";
import { createProtoMockRequest } from "../helpers/proto-test-helpers.ts";
import { caller, READ_DOC } from "../helpers/resource-gate-harness.ts";
import { buildResourceService, messageOf } from "../helpers/resource-test-helpers.ts";

/** A request stream that records how far it was pulled and whether it was released. */
function requestStream<T>(items: T[]) {
    const state = { pulled: 0, released: false };
    const iterable: AsyncIterable<T> = {
        [Symbol.asyncIterator]() {
            let index = 0;
            return {
                next: async () => {
                    if (index >= items.length) return { done: true, value: undefined };
                    state.pulled += 1;
                    return { done: false, value: items[index++] as T };
                },
                return: async () => {
                    state.released = true;
                    return { done: true, value: undefined };
                },
            };
        },
    };
    return { iterable, state };
}

async function call(options: { items?: Record<string, unknown>[]; answer?: ResourceDecision | null }) {
    const { service, methods } = buildResourceService({ Watch: { input: "DocRequest", kind: "server", auth: { resources: READ_DOC } } });
    const method = methods.Watch as NonNullable<typeof methods.Watch>;
    const messages = (options.items ?? [{ id: "d1" }]).map((item) => messageOf(method, item));
    const { iterable, state } = requestStream(messages);
    const asked: ResourceCheck[] = [];
    const answer = options.answer === undefined ? "allow" : options.answer;
    const interceptor = createProtoAuthzInterceptor({
        defaultPolicy: "deny",
        logger: { warn: () => undefined, error: () => undefined },
        ...(answer !== null && {
            resourceAuthorizer: {
                check: (input) => {
                    asked.push(input);
                    return answer;
                },
            },
        }),
    });
    const seen: unknown[] = [];
    let handled = 0;
    const handler = interceptor((async (req: { message: AsyncIterable<unknown> }) => {
        handled += 1;
        for await (const message of req.message) {
            seen.push(message);
        }
        return { message: {} };
    }) as never);
    let code: Code | undefined;
    try {
        await authContextStorage.run(caller, () => handler({ ...createProtoMockRequest(service, method), stream: true, message: iterable } as never));
    } catch (error) {
        code = ConnectError.from(error).code;
    }
    return { code, handled, seen, asked, state, messages };
}

describe("resource gate on a server-streaming method", () => {
    it("checks the resource of the first message and hands the handler that same message again", async () => {
        const result = await call({});
        assert.strictEqual(result.code, undefined);
        assert.strictEqual(result.asked.length, 1);
        assert.deepStrictEqual(result.asked[0]?.resource, { type: "doc", id: "d1" });
        assert.strictEqual(result.asked[0]?.context.message, result.messages[0]);
        assert.strictEqual(result.seen.length, 1);
        assert.strictEqual(result.seen[0], result.messages[0], "the handler must receive the very message that was checked");
    });

    it("passes on any further messages of the stream unchanged, in order", async () => {
        const result = await call({ items: [{ id: "d1" }, { id: "d2" }, { id: "d3" }] });
        assert.deepStrictEqual(result.seen, result.messages);
        assert.strictEqual(result.asked.length, 1, "only the first message names the resource");
    });

    it("does not run the handler after a denial", async () => {
        const result = await call({ answer: "deny" });
        assert.strictEqual(result.code, Code.PermissionDenied);
        assert.strictEqual(result.handled, 0);
    });

    it("without an authorizer denies before pulling anything from the stream", async () => {
        const result = await call({ answer: null });
        assert.strictEqual(result.code, Code.PermissionDenied);
        assert.strictEqual(result.state.pulled, 0);
    });

    it("an empty stream fails with InvalidArgument", async () => {
        const result = await call({ items: [] });
        assert.strictEqual(result.code, Code.InvalidArgument);
        assert.strictEqual(result.asked.length, 0);
        assert.strictEqual(result.handled, 0);
    });

    it("an empty id in the first message fails with InvalidArgument", async () => {
        const result = await call({ items: [{ id: "" }] });
        assert.strictEqual(result.code, Code.InvalidArgument);
        assert.strictEqual(result.asked.length, 0);
    });

    it("releases the request stream when the handler stops reading early", async () => {
        const { service, methods } = buildResourceService({ Watch: { input: "DocRequest", kind: "server", auth: { resources: READ_DOC } } });
        const method = methods.Watch as NonNullable<typeof methods.Watch>;
        const { iterable, state } = requestStream([messageOf(method, { id: "d1" }), messageOf(method, { id: "d2" })]);
        const interceptor = createProtoAuthzInterceptor({ resourceAuthorizer: { check: () => "allow" } });
        const handler = interceptor((async (req: { message: AsyncIterable<unknown> }) => {
            for await (const _message of req.message) {
                break;
            }
            return { message: {} };
        }) as never);
        await authContextStorage.run(caller, () => handler({ ...createProtoMockRequest(service, method), stream: true, message: iterable } as never));
        assert.strictEqual(state.released, true);
    });

    it("releases the request stream when the authorizer denies after the first message was read", async () => {
        const result = await call({ answer: "deny" });
        assert.strictEqual(result.code, Code.PermissionDenied);
        assert.strictEqual(result.state.pulled, 1);
        assert.strictEqual(result.state.released, true, "the stream read ahead must be released when the handler never gets it");
    });

    it("releases the request stream when the authorizer throws", async () => {
        const { service, methods } = buildResourceService({ Watch: { input: "DocRequest", kind: "server", auth: { resources: READ_DOC } } });
        const method = methods.Watch as NonNullable<typeof methods.Watch>;
        const { iterable, state } = requestStream([messageOf(method, { id: "d1" })]);
        const interceptor = createProtoAuthzInterceptor({
            logger: { warn: () => undefined, error: () => undefined },
            resourceAuthorizer: {
                check: () => {
                    throw new Error("engine down");
                },
            },
        });
        const handler = interceptor((async () => ({ message: {} })) as never);
        await assert.rejects(authContextStorage.run(caller, () => handler({ ...createProtoMockRequest(service, method), stream: true, message: iterable } as never)));
        assert.strictEqual(state.released, true);
    });

    it("releases the request stream when the reference in the first message is unreadable", async () => {
        const result = await call({ items: [{ id: "" }] });
        assert.strictEqual(result.code, Code.InvalidArgument);
        assert.strictEqual(result.state.released, true);
    });

    it("keeps the original refusal when releasing the request stream itself fails", async () => {
        const { service, methods } = buildResourceService({ Watch: { input: "DocRequest", kind: "server", auth: { resources: READ_DOC } } });
        const method = methods.Watch as NonNullable<typeof methods.Watch>;
        const first = messageOf(method, { id: "d1" });
        const iterable: AsyncIterable<unknown> = {
            [Symbol.asyncIterator]: () => ({
                next: async () => ({ done: false, value: first }),
                return: async () => {
                    throw new Error("close failed");
                },
            }),
        };
        const interceptor = createProtoAuthzInterceptor({ resourceAuthorizer: { check: () => "deny" } });
        const handler = interceptor((async () => ({ message: {} })) as never);
        const error = await authContextStorage
            .run(caller, () => handler({ ...createProtoMockRequest(service, method), stream: true, message: iterable } as never))
            .then(
                () => undefined,
                (caught: unknown) => caught,
            );
        assert.strictEqual(ConnectError.from(error).code, Code.PermissionDenied);
    });
});
