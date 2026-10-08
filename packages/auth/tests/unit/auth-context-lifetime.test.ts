/**
 * The verified identity lives as long as the response stream it was verified for.
 *
 * Every authentication factory that establishes an identity returns, for a
 * streaming call, a response whose iterable is advanced later by the transport.
 * These tests hand each factory a downstream that returns a streaming response
 * and drive the returned iterable the way a transport does, observing the
 * identity at the moment the iterator is created and at every next, return and
 * throw. They also pin down what the scope must not change: the response's
 * descriptors, headers, trailers and messages, the arguments, results and
 * errors of every iterator operation, which optional iterator methods exist,
 * and the caller's own async context.
 */

import assert from "node:assert";
import { AsyncLocalStorage } from "node:async_hooks";
import { describe, it } from "node:test";
import { createMockRequest } from "@connectum/testing";
import { authContextStorage, createAuthInterceptor, getAuthContext } from "../../src/index.ts";
import { AMBIENT_CALLER, AUTH_FACTORY_NAMES, type AuthFactoryName, createAuthSetup, jitter, SERVICE_NAME } from "../helpers/stream-context.ts";

const telemetry = new AsyncLocalStorage<string>();

interface Seen {
    op: string;
    identity: string | undefined;
    telemetry: string | undefined;
    receiverIsIterator: boolean;
    args: unknown[];
}

interface SpyOptions {
    withReturn?: boolean;
    withThrow?: boolean;
    results?: IteratorResult<unknown>[];
}

/** A hand-written async iterator that records what it observes; every optional method can be left out. */
function spy(options: SpyOptions = {}) {
    const { withReturn = true, withThrow = true } = options;
    const seen: Seen[] = [];
    const results = options.results ?? [{ done: false, value: "m0" }, { done: false, value: "m1" }];
    const returned: IteratorResult<unknown> = { done: true, value: "returned" };
    const thrown: IteratorResult<unknown> = { done: true, value: "thrown" };
    let position = 0;

    const note = (op: string, receiver: unknown, args: unknown[]) =>
        seen.push({ op, identity: getAuthContext()?.subject, telemetry: telemetry.getStore(), receiverIsIterator: receiver === iterator, args });

    const iterator: AsyncIterator<unknown> = {
        next(this: unknown, ...args: [] | [unknown]) {
            note("next", this, args);
            return Promise.resolve(results[position++] ?? { done: true, value: undefined });
        },
    };
    if (withReturn) {
        iterator.return = function (this: unknown, ...args: [] | [unknown]) {
            note("return", this, args);
            return Promise.resolve(returned);
        };
    }
    if (withThrow) {
        iterator.throw = function (this: unknown, ...args: [] | [unknown]) {
            note("throw", this, args);
            return Promise.resolve(thrown);
        };
    }

    const iterable: AsyncIterable<unknown> = {
        [Symbol.asyncIterator]() {
            note("create", iterable, []);
            return iterator;
        },
    };

    const header = new Headers({ "x-response": "1" });
    const trailer = new Headers({ "x-trailer": "1" });
    const service = { typeName: SERVICE_NAME };
    const method = { name: "Server" };
    const custom = { note: "application metadata" };
    const response = { stream: true, service, method, header, trailer, message: iterable, custom };
    return { seen, iterator, iterable, response, results, returned, thrown };
}

function requestFor(headers: Record<string, string>, stream = true) {
    return createMockRequest({ service: SERVICE_NAME, method: "Server", stream, headers: new Headers(headers) });
}

/** Authenticates `identity` through `name` and returns the response the interceptor hands back for `source`. */
async function respond(name: AuthFactoryName, identity: string, response: unknown) {
    const setup = createAuthSetup(name, [identity]);
    const headers = await setup.headersFor(identity);
    const handler = setup.interceptor(async () => response as never);
    if (name.endsWith("-cache")) {
        // The first call verifies and fills the credential cache; the one under test is served from it.
        await handler(requestFor(headers));
        assert.strictEqual(setup.verifications(identity), 1);
    }
    const result = await handler(requestFor(headers));
    if (name.endsWith("-cache")) {
        assert.strictEqual(setup.verifications(identity), 1, "the call under test must be a cache hit");
    }
    return result as unknown as { stream: true; message: AsyncIterable<unknown> } & Record<string, unknown>;
}

for (const name of AUTH_FACTORY_NAMES) {
    describe(`${name}: identity during response iteration`, () => {
        it("creates the iterator and runs next, return and throw under the verified identity", async () => {
            const source = spy();
            const iterator = (await respond(name, "alice", source.response)).message[Symbol.asyncIterator]();
            await iterator.next();
            await iterator.next();
            await iterator.return?.();

            const throwing = spy();
            const thrownIterator = (await respond(name, "alice", throwing.response)).message[Symbol.asyncIterator]();
            assert.ok(thrownIterator.throw, "the downstream iterator offers throw, so the scoped one must too");
            await thrownIterator.throw(new Error("injected"));

            assert.deepStrictEqual(
                source.seen.map((s) => [s.op, s.identity]),
                [
                    ["create", "alice"],
                    ["next", "alice"],
                    ["next", "alice"],
                    ["return", "alice"],
                ],
            );
            assert.deepStrictEqual(
                throwing.seen.map((s) => [s.op, s.identity]),
                [
                    ["create", "alice"],
                    ["throw", "alice"],
                ],
            );
        });

        it("restores the caller's own identity after every operation and keeps unrelated stores visible", async () => {
            const source = spy();
            const response = await respond(name, "alice", source.response);

            await authContextStorage.run(AMBIENT_CALLER, () =>
                telemetry.run("caller-telemetry", async () => {
                    const views: Array<string | undefined> = [getAuthContext()?.subject];
                    const iterator = response.message[Symbol.asyncIterator]();
                    views.push(getAuthContext()?.subject);
                    await iterator.next();
                    views.push(getAuthContext()?.subject);
                    await iterator.return?.();
                    views.push(getAuthContext()?.subject);
                    assert.deepStrictEqual(views, new Array(4).fill(AMBIENT_CALLER.subject), "the caller keeps its own identity around each operation");
                    assert.strictEqual(telemetry.getStore(), "caller-telemetry");
                }),
            );

            assert.strictEqual(getAuthContext(), undefined, "nothing leaks outside the caller's scope");
            assert.deepStrictEqual(
                source.seen.map((s) => [s.op, s.identity, s.telemetry]),
                [
                    ["create", "alice", "caller-telemetry"],
                    ["next", "alice", "caller-telemetry"],
                    ["return", "alice", "caller-telemetry"],
                ],
                "the verified identity replaces only the auth store; the caller's other stores stay visible to the handler side",
            );
        });

        it("keeps a real generator on the verified identity across await, yield and finally for overlapping identities", async () => {
            let violations = 0;
            const examples: string[] = [];
            const fail = (message: string) => {
                violations++;
                if (examples.length < 3) {
                    examples.push(message);
                }
            };

            const run = async (identity: string) => {
                const observed: Array<string | undefined> = [];
                async function* handler() {
                    observed.push(getAuthContext()?.subject);
                    await jitter();
                    observed.push(getAuthContext()?.subject);
                    try {
                        for (let i = 0; i < 3; i++) {
                            observed.push(getAuthContext()?.subject);
                            yield i;
                            observed.push(getAuthContext()?.subject);
                            await jitter();
                            observed.push(getAuthContext()?.subject);
                        }
                    } finally {
                        observed.push(getAuthContext()?.subject);
                    }
                }
                const response = await respond(name, identity, { stream: true, message: handler() });
                await jitter();
                for await (const _message of response.message) {
                    await jitter();
                }
                for (const view of observed) {
                    if (view !== identity) {
                        fail(`${identity} observed ${String(view)}`);
                    }
                }
                if (observed.length !== 2 + 3 * 3 + 1) {
                    fail(`${identity} produced ${observed.length} observations, so the handler did not run to the end`);
                }
            };

            for (let i = 0; i < 250; i++) {
                await Promise.all([run(`id-${i}-A`), run(`id-${i}-B`)]);
            }
            assert.strictEqual(violations, 0, `${violations} wrong or missing observations, e.g. ${examples.join("; ")}`);
        });
    });
}

describe("response iterator semantics are preserved", () => {
    it("keeps the descriptor, header, trailer and application metadata by reference and only replaces the message", async () => {
        const source = spy();
        const response = await respond("generic", "alice", source.response);
        assert.strictEqual(response.stream, true);
        assert.strictEqual(response.service, source.response.service);
        assert.strictEqual(response.method, source.response.method);
        assert.strictEqual(response.header, source.response.header);
        assert.strictEqual(response.trailer, source.response.trailer);
        assert.strictEqual(response.custom, source.response.custom);
        assert.deepStrictEqual(Object.keys(response).sort(), Object.keys(source.response).sort());
        assert.strictEqual(source.response.message, source.iterable, "the downstream response is not mutated");
    });

    it("does not consume the stream when the response is returned", async () => {
        const source = spy();
        await respond("generic", "alice", source.response);
        assert.deepStrictEqual(source.seen, []);
    });

    it("pulls the downstream exactly once per next, in order, and passes arguments, receivers and results through unchanged", async () => {
        const source = spy();
        const response = await respond("generic", "alice", source.response);
        const iterator = response.message[Symbol.asyncIterator]();

        const arg = { token: "argument" };
        const first = await iterator.next(arg);
        assert.strictEqual(first, source.results[0], "the result object is the downstream's own");
        assert.deepStrictEqual(source.seen.filter((s) => s.op === "next").length, 1, "one pull per next");
        const second = await iterator.next();
        assert.strictEqual(second, source.results[1]);

        const returnArg = { reason: "stop" };
        assert.strictEqual(await iterator.return?.(returnArg), source.returned);
        const injected = new Error("injected");
        assert.strictEqual(await iterator.throw?.(injected), source.thrown);

        assert.deepStrictEqual(
            source.seen.map((s) => s.receiverIsIterator),
            [false, true, true, true, true],
            "creation is called on the iterable; every iterator operation is called on the downstream iterator itself",
        );
        assert.strictEqual(source.seen[1]?.args[0], arg);
        assert.strictEqual(source.seen[2]?.args.length, 0);
        assert.strictEqual(source.seen[3]?.args[0], returnArg);
        assert.strictEqual(source.seen[4]?.args[0], injected);
    });

    it("leaves out return and throw when the downstream iterator has none", async () => {
        const source = spy({ withReturn: false, withThrow: false });
        const response = await respond("generic", "alice", source.response);
        const iterator = response.message[Symbol.asyncIterator]();
        assert.strictEqual(iterator.return, undefined);
        assert.strictEqual(iterator.throw, undefined);
        assert.strictEqual((await iterator.next()).value, "m0");
    });

    it("offers return without throw when the downstream iterator has only return", async () => {
        const source = spy({ withThrow: false });
        const response = await respond("generic", "alice", source.response);
        const iterator = response.message[Symbol.asyncIterator]();
        assert.strictEqual(typeof iterator.return, "function");
        assert.strictEqual(iterator.throw, undefined);
    });

    it("delivers the downstream's rejection, synchronous failure and termination results unchanged", async () => {
        const rejection = new Error("downstream rejected");
        const syncFailure = new Error("downstream threw synchronously");
        let mode: "reject" | "throw" = "reject";
        const iterable: AsyncIterable<unknown> = {
            [Symbol.asyncIterator]: () => ({
                next: () => {
                    if (mode === "throw") {
                        throw syncFailure;
                    }
                    return Promise.reject(rejection);
                },
            }),
        };
        const response = await respond("generic", "alice", { stream: true, message: iterable });
        const iterator = response.message[Symbol.asyncIterator]();
        await assert.rejects(iterator.next(), (error) => error === rejection);
        mode = "throw";
        assert.throws(
            () => iterator.next(),
            (error) => error === syncFailure,
        );
    });

    it("reports a failure of the iterable's own creation to the consumer unchanged", async () => {
        const failure = new Error("cannot create iterator");
        const response = await respond("generic", "alice", {
            stream: true,
            message: {
                [Symbol.asyncIterator]() {
                    throw failure;
                },
            },
        });
        assert.throws(
            () => response.message[Symbol.asyncIterator](),
            (error) => error === failure,
        );
    });

    it("hands a unary response back as the very same object, produced under the verified identity", async () => {
        const unary = { stream: false, message: { value: "x" } };
        let identityInHandler: string | undefined;
        const setup = createAuthSetup("generic", []);
        const handler = setup.interceptor(async () => {
            identityInHandler = getAuthContext()?.subject;
            return unary as never;
        });
        const result = await handler(requestFor(await setup.headersFor("alice"), false));
        assert.strictEqual(result, unary);
        assert.strictEqual(identityInHandler, "alice");
    });

    it("lets the downstream's failure to produce a response through unchanged", async () => {
        const failure = new Error("downstream refused");
        const setup = createAuthSetup("generic", []);
        const handler = setup.interceptor(async () => {
            throw failure;
        });
        await assert.rejects(handler(requestFor(await setup.headersFor("alice"))), (error) => error === failure);
        assert.strictEqual(getAuthContext(), undefined);
    });

    it("passes a skipped method through without wrapping its response", async () => {
        const source = spy();
        const interceptor = createAuthInterceptor({ verifyCredentials: () => assert.fail("not called"), skipMethods: [`${SERVICE_NAME}/Server`] });
        const result = await interceptor(async () => source.response as never)(requestFor({}));
        assert.strictEqual(result, source.response, "a skipped method returns the downstream response untouched");
    });
});
