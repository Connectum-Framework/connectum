/**
 * Unit tests for serializer interceptor
 *
 * The serializer turns the protobuf request message into its JSON form for the
 * downstream handler and the JSON response back into a protobuf message. The
 * expected JSON forms come from the protobuf JSON mapping (a zero scalar is
 * left out unless implicit values are emitted), checked with a real schema.
 *
 * @module serializer.test
 */

import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { create, isMessage } from '@bufbuild/protobuf';
import { createMockRequest } from '@connectum/test-fixtures';
import { type Item, ItemSchema } from '../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts';
import { createSerializerInterceptor } from '../../src/serializer.ts';

const NAMESPACED_SERVICE = 'streaming.v1.StreamingService';
const GRPC_SERVICE = 'grpc.health.v1.Health';

function unaryRequest(service: string, message: unknown, stream = false) {
    const req = createMockRequest({ service, method: 'Method', message, stream });
    req.method = { name: 'Method', input: ItemSchema, output: ItemSchema };
    return req;
}

function jsonResponse(service: string, message: unknown, stream = false) {
    return { stream, service: { typeName: service }, method: { name: 'Method', input: ItemSchema, output: ItemSchema }, message };
}

async function* items<T>(...values: T[]): AsyncGenerator<T> {
    for (const value of values) yield value;
}

/** Drains an async iterable into an array. */
async function collect<T>(stream: AsyncIterable<T>): Promise<T[]> {
    const out: T[] = [];
    for await (const value of stream) out.push(value);
    return out;
}

describe('serializer interceptor', () => {
    describe('unary request', () => {
        it('should hand the downstream the JSON form of the request, emitting implicit values by default', async () => {
            const next = mock.fn(async (_req: unknown) => jsonResponse(NAMESPACED_SERVICE, { value: 'ok' }));

            await createSerializerInterceptor()(next as any)(unaryRequest(NAMESPACED_SERVICE, create(ItemSchema, { value: 'a' })));

            assert.strictEqual(next.mock.calls.length, 1);
            assert.deepStrictEqual((next.mock.calls[0]!.arguments[0] as { message: unknown }).message, { value: 'a', sequence: 0 });
        });

        it('should leave implicit values out of the request JSON when alwaysEmitImplicit=false', async () => {
            const next = mock.fn(async (_req: unknown) => jsonResponse(NAMESPACED_SERVICE, { value: 'ok' }));

            await createSerializerInterceptor({ alwaysEmitImplicit: false })(next as any)(unaryRequest(NAMESPACED_SERVICE, create(ItemSchema, { value: 'a' })));

            assert.deepStrictEqual((next.mock.calls[0]!.arguments[0] as { message: unknown }).message, { value: 'a' });
        });

        it('should keep the other request fields and not modify the caller request', async () => {
            const next = mock.fn(async (_req: unknown) => jsonResponse(NAMESPACED_SERVICE, { value: 'ok' }));
            const original = create(ItemSchema, { value: 'a', sequence: 3 });
            const req = unaryRequest(NAMESPACED_SERVICE, original);

            await createSerializerInterceptor()(next as any)(req);

            const forwarded = next.mock.calls[0]!.arguments[0] as typeof req;
            assert.notStrictEqual(forwarded, req);
            assert.strictEqual(forwarded.url, req.url);
            assert.strictEqual(forwarded.signal, req.signal);
            assert.strictEqual(forwarded.header, req.header);
            assert.strictEqual(req.message, original, 'the caller request must still hold the protobuf message');
        });
    });

    describe('unary response', () => {
        it('should turn the JSON response into a protobuf message', async () => {
            const next = mock.fn(async (_req: unknown) => jsonResponse(NAMESPACED_SERVICE, { value: 'x', sequence: 7 }));

            const result = await createSerializerInterceptor()(next as any)(unaryRequest(NAMESPACED_SERVICE, create(ItemSchema)));

            assert.ok(isMessage(result.message, ItemSchema), 'the response message must be a protobuf Item');
            const item = result.message as Item;
            assert.strictEqual(item.value, 'x');
            assert.strictEqual(item.sequence, 7);
        });

        it('should ignore unknown response fields by default', async () => {
            const next = mock.fn(async (_req: unknown) => jsonResponse(NAMESPACED_SERVICE, { value: 'x', extraField: 1 }));

            const result = await createSerializerInterceptor()(next as any)(unaryRequest(NAMESPACED_SERVICE, create(ItemSchema)));

            assert.strictEqual((result.message as Item).value, 'x');
            assert.ok(!('extraField' in (result.message as object)), 'the unknown field must be dropped');
        });

        it('should refuse unknown response fields when ignoreUnknownFields=false', async () => {
            const next = mock.fn(async (_req: unknown) => jsonResponse(NAMESPACED_SERVICE, { value: 'x', extraField: 1 }));

            await assert.rejects(() => createSerializerInterceptor({ ignoreUnknownFields: false })(next as any)(unaryRequest(NAMESPACED_SERVICE, create(ItemSchema))), /extraField/);
        });

        // A real handler answers with a protobuf message, which carries its `$typeName` marker.
        // Parsing it again as if it were JSON made strict unknown-field handling reject that
        // marker, so every valid call failed. A response that already is a message of the
        // output type stays as it is, whatever the option.
        for (const ignoreUnknownFields of [true, false]) {
            it(`should return a response that already is a message of the output type as it is (ignoreUnknownFields=${ignoreUnknownFields})`, async () => {
                const response = create(ItemSchema, { value: 'x', sequence: 7 });
                const next = mock.fn(async (_req: unknown) => jsonResponse(NAMESPACED_SERVICE, response));

                const result = await createSerializerInterceptor({ ignoreUnknownFields })(next as any)(unaryRequest(NAMESPACED_SERVICE, create(ItemSchema)));

                assert.strictEqual(result.message, response);
            });
        }

        it('should let a downstream failure through unchanged', async () => {
            const failure = new Error('downstream failed');
            const next = mock.fn(async () => {
                throw failure;
            });

            await assert.rejects(
                () => createSerializerInterceptor()(next as any)(unaryRequest(NAMESPACED_SERVICE, create(ItemSchema))),
                (err: unknown) => err === failure,
            );
        });
    });

    describe('grpc.* services', () => {
        it('should pass a grpc.* call through untouched by default', async () => {
            const req = unaryRequest(GRPC_SERVICE, { service: 'x' });
            const res = jsonResponse(GRPC_SERVICE, { status: 'SERVING' });
            const next = mock.fn(async (_req: unknown) => res);

            const result = await createSerializerInterceptor()(next as any)(req);

            assert.strictEqual(next.mock.calls[0]!.arguments[0], req, 'the very same request object must reach the downstream');
            assert.strictEqual(result, res, 'the very same response object must come back');
        });

        it('should convert a grpc.* call when skipGrpcServices=false', async () => {
            const next = mock.fn(async (_req: unknown) => jsonResponse(GRPC_SERVICE, { value: 'x' }));

            const result = await createSerializerInterceptor({ skipGrpcServices: false })(next as any)(unaryRequest(GRPC_SERVICE, create(ItemSchema, { value: 'a' })));

            assert.deepStrictEqual((next.mock.calls[0]!.arguments[0] as { message: unknown }).message, { value: 'a', sequence: 0 });
            assert.ok(isMessage(result.message, ItemSchema));
        });

        it('should treat only the grpc. namespace as grpc services', async () => {
            // "grpcx." and "my.grpc." are application namespaces and are converted.
            for (const service of ['grpcx.v1.Service', 'my.grpc.v1.Service']) {
                const next = mock.fn(async (_req: unknown) => jsonResponse(service, { value: 'x' }));

                const result = await createSerializerInterceptor()(next as any)(unaryRequest(service, create(ItemSchema, { value: 'a' })));

                assert.deepStrictEqual((next.mock.calls[0]!.arguments[0] as { message: unknown }).message, { value: 'a', sequence: 0 }, service);
                assert.ok(isMessage(result.message, ItemSchema), service);
            }
        });
    });

    describe('streaming', () => {
        it('should hand the downstream the JSON form of every streamed request message', async () => {
            let seen: unknown[] = [];
            const next = mock.fn(async (req: { message: AsyncIterable<unknown> }) => {
                seen = await collect(req.message);
                return jsonResponse(NAMESPACED_SERVICE, items(), true);
            });
            const request = unaryRequest(NAMESPACED_SERVICE, items(create(ItemSchema, { value: 'a', sequence: 1 }), create(ItemSchema, { value: 'b' })), true);

            await createSerializerInterceptor()(next as any)(request);

            assert.deepStrictEqual(seen, [
                { value: 'a', sequence: 1 },
                { value: 'b', sequence: 0 },
            ]);
        });

        it('should leave implicit values out of streamed request JSON when alwaysEmitImplicit=false', async () => {
            let seen: unknown[] = [];
            const next = mock.fn(async (req: { message: AsyncIterable<unknown> }) => {
                seen = await collect(req.message);
                return jsonResponse(NAMESPACED_SERVICE, items(), true);
            });
            const request = unaryRequest(NAMESPACED_SERVICE, items(create(ItemSchema, { value: 'b' })), true);

            await createSerializerInterceptor({ alwaysEmitImplicit: false })(next as any)(request);

            assert.deepStrictEqual(seen, [{ value: 'b' }]);
        });

        it('should turn every streamed JSON response message into a protobuf message', async () => {
            const next = mock.fn(async (_req: unknown) => jsonResponse(NAMESPACED_SERVICE, items({ value: 'x', sequence: 1 }, { value: 'y', sequence: 2 }), true));

            const result = await createSerializerInterceptor()(next as any)(unaryRequest(NAMESPACED_SERVICE, items(), true));

            const received = await collect(result.message as AsyncIterable<Item>);
            assert.strictEqual(result.stream, true);
            assert.deepStrictEqual(
                received.map((m) => [isMessage(m, ItemSchema), m.value, m.sequence]),
                [
                    [true, 'x', 1],
                    [true, 'y', 2],
                ],
            );
        });

        it('should return streamed response messages that already are messages as they are when ignoreUnknownFields=false', async () => {
            const first = create(ItemSchema, { value: 'x', sequence: 1 });
            const second = create(ItemSchema, { value: 'y', sequence: 2 });
            const next = mock.fn(async (_req: unknown) => jsonResponse(NAMESPACED_SERVICE, items(first, second), true));

            const result = await createSerializerInterceptor({ ignoreUnknownFields: false })(next as any)(unaryRequest(NAMESPACED_SERVICE, items(), true));

            const received = await collect(result.message as AsyncIterable<Item>);
            assert.strictEqual(received.length, 2);
            assert.strictEqual(received[0], first);
            assert.strictEqual(received[1], second);
        });

        it('should refuse an unknown field in a streamed response when ignoreUnknownFields=false', async () => {
            const next = mock.fn(async (_req: unknown) => jsonResponse(NAMESPACED_SERVICE, items({ value: 'x', extraField: 1 }), true));

            const result = await createSerializerInterceptor({ ignoreUnknownFields: false })(next as any)(unaryRequest(NAMESPACED_SERVICE, items(), true));

            await assert.rejects(() => collect(result.message as AsyncIterable<Item>), /extraField/);
        });
    });
});
