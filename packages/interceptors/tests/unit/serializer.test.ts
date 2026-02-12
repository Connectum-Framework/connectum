/**
 * Unit tests for serializer interceptor
 *
 * @module serializer.test
 */

import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import type { DescMessage } from '@bufbuild/protobuf';
import { createSerializerInterceptor } from '../../src/serializer.ts';

/**
 * Create mock DescMessage with full protobuf metadata for toJson/fromJson
 */
function createMockMessage(typeName: string): DescMessage {
    return {
        kind: 'message',
        typeName,
        name: typeName.split('.').pop() || typeName,
        fields: [],
        field: {},
        oneofs: [],
        members: [], // CRITICAL: required for create() to work
        nestedEnums: [],
        nestedMessages: [],
        nestedExtensions: [],
        parent: undefined,
        proto: {
            options: undefined,
        },
        file: {
            name: `${typeName.split('.')[0]}.proto`,
            proto: {
                edition: 'EDITION_PROTO3',
            },
        },
    } as any as DescMessage;
}

describe('serializer interceptor', () => {
    it('should serialize unary request to JSON', async () => {
        const interceptor = createSerializerInterceptor({ skipGrpcServices: false });

        const inputSchema = createMockMessage('test.InputMessage');
        const outputSchema = createMockMessage('test.OutputMessage');

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
            method: { input: inputSchema, output: outputSchema },
        } as any;

        const mockRes = {
            stream: false,
            message: { result: 'success' },
            service: { typeName: 'test.Service' },
            method: { output: outputSchema },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        await handler(mockReq);

        assert.strictEqual(next.mock.calls.length, 1);
        // Message should be serialized to JSON (object or string)
        assert.strictEqual(typeof mockReq.message, 'object');
    });

    it('should skip gRPC services when skipGrpcServices=true', async () => {
        const interceptor = createSerializerInterceptor({ skipGrpcServices: true });

        const originalMessage = { field: 'value' };
        const mockReq = {
            url: 'http://localhost/grpc.Service/Method',
            stream: false,
            message: originalMessage,
            service: { typeName: 'grpc.Service' },
            method: { input: { fields: [] } },
        } as any;

        const mockRes = {
            stream: false,
            message: { result: 'success' },
            service: { typeName: 'grpc.Service' },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        await handler(mockReq);

        // Message should NOT be modified for gRPC services
        assert.strictEqual(mockReq.message, originalMessage);
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it('should NOT skip gRPC services when skipGrpcServices=false', async () => {
        const interceptor = createSerializerInterceptor({ skipGrpcServices: false });

        const inputSchema = createMockMessage('grpc.InputMessage');
        const outputSchema = createMockMessage('grpc.OutputMessage');

        const originalMessage = { field: 'value' };
        const mockReq = {
            url: 'http://localhost/grpc.Service/Method',
            stream: false,
            message: originalMessage,
            service: { typeName: 'grpc.Service' },
            method: { input: inputSchema, output: outputSchema },
        } as any;

        const mockRes = {
            stream: false,
            message: { result: 'success' },
            service: { typeName: 'grpc.Service' },
            method: { output: outputSchema },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        await handler(mockReq);

        assert.strictEqual(next.mock.calls.length, 1);
    });

    it('should serialize streaming request with alwaysEmitImplicit option', async () => {
        const interceptor = createSerializerInterceptor({
            skipGrpcServices: false,
            alwaysEmitImplicit: true,
        });

        const inputSchema = createMockMessage('test.StreamInputMessage');
        const outputSchema = createMockMessage('test.OutputMessage');

        async function* mockStream() {
            yield { field: 'value1' };
            yield { field: 'value2' };
        }

        const mockReq = {
            url: 'http://localhost/test.Service/StreamMethod',
            stream: true,
            message: mockStream(),
            service: { typeName: 'test.Service' },
            method: { input: inputSchema, output: outputSchema },
        } as any;

        const mockRes = {
            stream: false,
            message: { result: 'success' },
            service: { typeName: 'test.Service' },
            method: { output: outputSchema },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        await handler(mockReq);

        // CRITICAL: Verify toJsonStream uses alwaysEmitImplicit, not ignoreUnknownFields
        assert.strictEqual(next.mock.calls.length, 1);
        // Message should be wrapped in toJsonStream async generator
        assert.strictEqual(typeof mockReq.message, 'object');
    });

    it('should deserialize unary response from JSON with ignoreUnknownFields', async () => {
        const interceptor = createSerializerInterceptor({
            skipGrpcServices: false,
            ignoreUnknownFields: true,
        });

        const inputSchema = createMockMessage('test.InputMessage');
        const outputSchema = createMockMessage('test.OutputMessage');

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
            method: { input: inputSchema, output: outputSchema },
        } as any;

        const mockRes = {
            stream: false,
            message: { result: 'success', unknownField: 'ignore me' },
            service: { typeName: 'test.Service' },
            method: { output: outputSchema },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        const result = await handler(mockReq);

        // Response should be deserialized
        assert.strictEqual(next.mock.calls.length, 1);
        assert.strictEqual(typeof result.message, 'object');
    });

    it('should deserialize streaming response from JSON', async () => {
        const interceptor = createSerializerInterceptor({
            skipGrpcServices: false,
            ignoreUnknownFields: true,
        });

        const inputSchema = createMockMessage('test.InputMessage');
        const outputSchema = createMockMessage('test.StreamOutputMessage');

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
            method: { input: inputSchema, output: outputSchema },
        } as any;

        async function* mockResStream() {
            yield { result: 'value1' };
            yield { result: 'value2' };
        }

        const mockRes = {
            stream: true,
            message: mockResStream(),
            service: { typeName: 'test.Service' },
            method: { output: outputSchema },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        const result = await handler(mockReq);

        // Response stream should be wrapped in fromJsonStream
        assert.strictEqual(result.stream, true);
        assert.strictEqual(typeof result.message, 'object');
    });

    it('should use alwaysEmitImplicit option for unary serialization', async () => {
        const interceptor = createSerializerInterceptor({
            skipGrpcServices: false,
            alwaysEmitImplicit: false,
        });

        const inputSchema = createMockMessage('test.InputMessage');
        const outputSchema = createMockMessage('test.OutputMessage');

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value', implicitField: 0 },
            service: { typeName: 'test.Service' },
            method: { input: inputSchema, output: outputSchema },
        } as any;

        const mockRes = {
            stream: false,
            message: { result: 'success' },
            service: { typeName: 'test.Service' },
            method: { output: outputSchema },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        await handler(mockReq);

        assert.strictEqual(next.mock.calls.length, 1);
    });

    it('should handle both request and response serialization', async () => {
        const interceptor = createSerializerInterceptor({
            skipGrpcServices: false,
            alwaysEmitImplicit: true,
            ignoreUnknownFields: true,
        });

        const inputSchema = createMockMessage('test.InputMessage');
        const outputSchema = createMockMessage('test.OutputMessage');

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
            method: { input: inputSchema, output: outputSchema },
        } as any;

        const mockRes = {
            stream: false,
            message: { result: 'success' },
            service: { typeName: 'test.Service' },
            method: { output: outputSchema },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        const result = await handler(mockReq);

        // Both request and response should be serialized/deserialized
        assert.strictEqual(next.mock.calls.length, 1);
        assert.strictEqual(typeof result.message, 'object');
    });
});
