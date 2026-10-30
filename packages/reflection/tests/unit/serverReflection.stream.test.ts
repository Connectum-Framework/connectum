/**
 * How the ServerReflectionInfo handlers end a stream.
 *
 * The handlers are driven directly with a request iterator the test controls,
 * because the case that matters cannot be produced by a well-behaved client:
 * the handler is parked waiting for the next request, the call's signal aborts
 * (server shutdown, client cancel, deadline) and nothing else will ever wake
 * it. A request iterator does not end by itself when the signal aborts, so a
 * handler that only loops over it stays parked until the client sends or
 * closes, and a server that is stopping waits for it.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { ServerReflectionRequestSchema } from "#gen/grpc/reflection/v1/reflection_pb.js";
import { ServerReflectionRequestSchema as V1alphaRequestSchema } from "#gen/grpc/reflection/v1alpha/reflection_pb.js";
import { createDescriptorPool } from "../../src/descriptorPool.ts";
import { registerServerReflection } from "../../src/serverReflection.ts";

type Handler = (requests: AsyncIterable<unknown>, context: { signal: AbortSignal }) => AsyncIterable<{ messageResponse: { case?: string } }>;

const VERSIONS = [
    { name: "v1", typeName: "grpc.reflection.v1.ServerReflection", request: () => create(ServerReflectionRequestSchema, { messageRequest: { case: "listServices", value: "" } }) },
    { name: "v1alpha", typeName: "grpc.reflection.v1alpha.ServerReflection", request: () => create(V1alphaRequestSchema, { messageRequest: { case: "listServices", value: "" } }) },
] as const;

function handlers(): Map<string, Handler> {
    const impls = new Map<string, Handler>();
    registerServerReflection(
        {
            service: (desc: { typeName: string }, impl: { serverReflectionInfo: Handler }) => {
                impls.set(desc.typeName, impl.serverReflectionInfo);
            },
        } as never,
        createDescriptorPool({ files: [], services: [] }),
    );
    return impls;
}

/** A request iterator that yields what the test pushes and otherwise waits, like a client holding the stream open. */
function controlledRequests() {
    const queue: unknown[] = [];
    let wake: (() => void) | undefined;
    let ended = false;
    let failure: unknown;
    let returnCalls = 0;
    const requests: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]() {
            return {
                async next(): Promise<IteratorResult<unknown>> {
                    for (;;) {
                        if (failure !== undefined) {
                            throw failure;
                        }
                        if (queue.length > 0) {
                            return { done: false, value: queue.shift() };
                        }
                        if (ended) {
                            return { done: true, value: undefined };
                        }
                        await new Promise<void>((resolve) => {
                            wake = resolve;
                        });
                    }
                },
                async return(): Promise<IteratorResult<unknown>> {
                    returnCalls++;
                    ended = true;
                    wake?.();
                    return { done: true, value: undefined };
                },
            };
        },
    };
    return {
        requests,
        push(request: unknown) {
            queue.push(request);
            wake?.();
        },
        end() {
            ended = true;
            wake?.();
        },
        fail(error: unknown) {
            failure = error;
            wake?.();
        },
        get returnCalls() {
            return returnCalls;
        },
    };
}

const WITHIN_MS = 1000;

/** Resolves with "ended" when the promise settles in time, "hung" otherwise. */
async function endsWithin<T>(promise: Promise<T>, ms = WITHIN_MS): Promise<"ended" | "hung"> {
    let timer: NodeJS.Timeout | undefined;
    const hung = new Promise<"hung">((resolve) => {
        timer = setTimeout(() => resolve("hung"), ms);
    });
    try {
        return await Promise.race([promise.then(() => "ended" as const, () => "ended" as const), hung]);
    } finally {
        clearTimeout(timer);
    }
}

for (const version of VERSIONS) {
    describe(`${version.typeName} stream`, () => {
        function start(signal: AbortSignal, source: ReturnType<typeof controlledRequests>) {
            const handler = handlers().get(version.typeName);
            assert.ok(handler, `${version.typeName} must be mounted`);
            const iterator = handler(source.requests, { signal })[Symbol.asyncIterator]();
            return iterator;
        }

        it("ends when the signal aborts while it waits for the next request", async () => {
            const controller = new AbortController();
            const source = controlledRequests();
            const iterator = start(controller.signal, source);

            source.push(version.request());
            const first = await iterator.next();
            assert.strictEqual(first.done, false);
            assert.strictEqual(first.value.messageResponse.case, "listServicesResponse");

            // The handler is now parked in the request iterator, as an idle grpcurl session leaves it.
            const next = iterator.next();
            await new Promise((resolve) => setTimeout(resolve, 20));
            controller.abort();

            assert.strictEqual(await endsWithin(next), "ended", "the stream must end after the abort, not wait for the client");
            assert.deepStrictEqual(await next, { done: true, value: undefined });
        });

        it("ends at once when the signal was already aborted", async () => {
            const controller = new AbortController();
            controller.abort();
            const source = controlledRequests();
            const iterator = start(controller.signal, source);

            assert.strictEqual(await endsWithin(iterator.next()), "ended");
        });

        it("releases the request iterator it stopped reading", async () => {
            const controller = new AbortController();
            const source = controlledRequests();
            const iterator = start(controller.signal, source);
            const next = iterator.next();
            await new Promise((resolve) => setTimeout(resolve, 20));
            controller.abort();
            assert.strictEqual(await endsWithin(next), "ended");

            assert.ok(source.returnCalls >= 1, "the request iterator must be closed so its source can release the call");
        });

        it("leaves no unhandled rejection when the abandoned request iterator fails later", async () => {
            const unhandled: unknown[] = [];
            const record = (reason: unknown): void => {
                unhandled.push(reason);
            };
            process.on("unhandledRejection", record);
            try {
                const controller = new AbortController();
                const source = controlledRequests();
                const iterator = start(controller.signal, source);
                const next = iterator.next();
                await new Promise((resolve) => setTimeout(resolve, 20));
                controller.abort();
                assert.strictEqual(await endsWithin(next), "ended");

                // The read the handler gave up on rejects afterwards, as a reset stream does.
                source.fail(new Error("stream reset"));
                await new Promise((resolve) => setTimeout(resolve, 50));
            } finally {
                process.off("unhandledRejection", record);
            }
            assert.deepStrictEqual(unhandled, []);
        });

        it("still answers every request and ends when the client closes its side", async () => {
            const controller = new AbortController();
            const source = controlledRequests();
            const iterator = start(controller.signal, source);

            source.push(version.request());
            source.push(version.request());
            source.end();
            const seen: Array<string | undefined> = [];
            for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
                seen.push(step.value.messageResponse.case);
            }
            assert.deepStrictEqual(seen, ["listServicesResponse", "listServicesResponse"]);
        });

        it("passes an error of the request stream on to the caller", async () => {
            const controller = new AbortController();
            const source = controlledRequests();
            const iterator = start(controller.signal, source);
            source.fail(new Error("stream reset"));

            await assert.rejects(iterator.next(), /stream reset/);
        });
    });
}
