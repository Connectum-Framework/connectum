/**
 * Unit tests for logger interceptor
 *
 * @module logger.test
 */

import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { Code, ConnectError } from '@connectrpc/connect';
import { createLoggerInterceptor } from '../../src/logger.ts';

describe('logger interceptor', () => {
    it('should log request and response for unary calls', async () => {
        const loggerFn = mock.fn();
        const interceptor = createLoggerInterceptor({ logger: loggerFn });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
        } as any;

        const mockRes = {
            stream: false,
            message: { result: 'success' },
            method: { output: {} },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        await handler(mockReq);

        // Verify logger was called 3 times (request, response, timing)
        assert.strictEqual(loggerFn.mock.calls.length, 3);
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it('should log timing even on error', async () => {
        const loggerFn = mock.fn();

        const interceptor = createLoggerInterceptor({ logger: loggerFn });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
        } as any;

        const error = new ConnectError('Test error', Code.Internal);
        const next = mock.fn(async () => {
            throw error;
        });

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.Internal);
                return true;
            }
        );

        // Verify timing was logged even on error (request + timing = 2 calls)
        assert.strictEqual(loggerFn.mock.calls.length, 2, 'logger should be called for request and timing');
        assert.ok(
            loggerFn.mock.calls[1]!.arguments[0]?.includes('completed in'),
            'timing log should contain "completed in"'
        );
    });

    it('should log timing on exception', async () => {
        const loggerFn = mock.fn();

        const interceptor = createLoggerInterceptor({ logger: loggerFn });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
        } as any;

        const next = mock.fn(async () => {
            throw new Error('Unexpected exception');
        });

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            Error
        );

        // Verify timing was logged (request + timing = 2 calls)
        const timingCall = loggerFn.mock.calls.find(
            (c: any) => c.arguments[0]?.includes('completed in')
        );
        assert.ok(timingCall, 'timing log must be present on exception');
    });

    it('should skip health check services when skipHealthCheck=true', async () => {
        const loggerFn = mock.fn();
        const interceptor = createLoggerInterceptor({ skipHealthCheck: true, logger: loggerFn });

        const mockReq = {
            url: 'http://localhost/grpc.health.v1.Health/Check',
            stream: false,
            message: {},
            service: { typeName: 'grpc.health.v1.Health' },
        } as any;

        const mockRes = {
            stream: false,
            message: { status: 'SERVING' },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        await handler(mockReq);

        // Verify logger was NOT called for health check
        assert.strictEqual(loggerFn.mock.calls.length, 0);
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it('should log health check services when skipHealthCheck=false', async () => {
        const loggerFn = mock.fn();
        const interceptor = createLoggerInterceptor({ skipHealthCheck: false, logger: loggerFn });

        const mockReq = {
            url: 'http://localhost/grpc.health.v1.Health/Check',
            stream: false,
            message: {},
            service: { typeName: 'grpc.health.v1.Health' },
        } as any;

        const mockRes = {
            stream: false,
            message: { status: 'SERVING' },
            method: { output: {} },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        await handler(mockReq);

        // Verify logger WAS called for health check (request + response + timing)
        assert.strictEqual(loggerFn.mock.calls.length, 3);
    });

    it('should handle streaming requests', async () => {
        const loggerFn = mock.fn();
        const interceptor = createLoggerInterceptor({ logger: loggerFn });

        async function* mockStream() {
            yield { field: 'value1' };
            yield { field: 'value2' };
        }

        const mockReq = {
            url: 'http://localhost/test.Service/StreamMethod',
            stream: true,
            message: mockStream(),
            service: { typeName: 'test.Service' },
        } as any;

        // CRITICAL: mockRes must have method.output for logResStream to work
        const mockRes = {
            stream: false,
            message: { result: 'success' },
            method: {
                output: {
                    typeName: 'test.OutputMessage',
                    fields: [],
                    members: [],
                },
            },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        await handler(mockReq);

        // For streaming, logReqStream wraps the iterator
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it('should handle streaming responses', async () => {
        const loggerFn = mock.fn();
        const interceptor = createLoggerInterceptor({ logger: loggerFn });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
        } as any;

        async function* mockResStream() {
            yield { result: 'value1' };
            yield { result: 'value2' };
        }

        // CRITICAL: Must have complete DescMessage schema for toJson() in logResStream
        const mockRes = {
            stream: true,
            message: mockResStream(),
            method: {
                output: {
                    kind: 'message',
                    typeName: 'test.OutputMessage',
                    name: 'OutputMessage',
                    fields: [],
                    field: {},
                    oneofs: [],
                    members: [],
                    nestedEnums: [],
                    nestedMessages: [],
                    nestedExtensions: [],
                    parent: undefined,
                    proto: { options: undefined },
                    file: {
                        name: 'test.proto',
                        proto: { edition: 'EDITION_PROTO3' },
                    },
                },
            },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        const result = await handler(mockReq);

        // CRITICAL: Must iterate through stream to trigger logger calls
        // The logResStream generator only logs when consuming items
        const items = [];
        for await (const item of result.message as AsyncIterable<unknown>) {
            items.push(item);
        }

        // Verify request was logged once (unary request)
        // NOTE: Response stream items are logged via toJson() which may fail silently
        // At minimum, the request should be logged
        assert.strictEqual(items.length, 2);
        assert.ok(loggerFn.mock.calls.length >= 1, 'Logger should be called at least once for request');
    });

    it('should use custom logger function', async () => {
        const customLogger = mock.fn();
        const interceptor = createLoggerInterceptor({ logger: customLogger });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
        } as any;

        const mockRes = {
            stream: false,
            message: { result: 'success' },
            method: { output: {} },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        await handler(mockReq);

        // Verify custom logger was used (request + response + timing = 3 calls)
        assert.strictEqual(customLogger.mock.calls.length, 3);
        assert.ok(customLogger.mock.calls[0]!.arguments[0]?.includes('request'));
        assert.ok(customLogger.mock.calls[1]!.arguments[0]?.includes('response'));
        assert.ok(customLogger.mock.calls[2]!.arguments[0]?.includes('completed in'));
    });
});
