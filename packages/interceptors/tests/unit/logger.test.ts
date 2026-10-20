/**
 * Unit tests for logger interceptor
 *
 * @module logger.test
 */

import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { Code } from '@connectrpc/connect';
import { assertConnectError, createMockNextError, createMockRequest } from '@connectum/test-fixtures';
import { createLoggerInterceptor } from '../../src/logger.ts';

describe('logger interceptor', () => {
    it('should log request and response for unary calls', async () => {
        const loggerFn = mock.fn();
        const interceptor = createLoggerInterceptor({ logger: loggerFn });

        const mockReq = createMockRequest({ service: 'test.Service', method: 'Method', message: { field: 'value' } });

        const mockRes = {
            stream: false,
            message: { result: 'success' },
            method: { output: {} },
        };

        const next = mock.fn(async () => mockRes);
        const handler = interceptor(next as any);

        await handler(mockReq);

        // A unary call writes exactly three lines, in this order: request, response, completion.
        // With bodies off (the default) no line carries an argument.
        assert.strictEqual(next.mock.calls.length, 1);
        const lines = loggerFn.mock.calls.map((call) => call.arguments);
        assert.strictEqual(lines.length, 3);
        assert.deepStrictEqual(lines[0], ['RPC /test.Service/Method request']);
        assert.deepStrictEqual(lines[1], ['RPC /test.Service/Method response']);
        assert.strictEqual(lines[2]!.length, 1);
        assert.match(lines[2]![0] as string, /^RPC \/test\.Service\/Method completed in \d+(\.\d+)?ms$/);
    });

    it('should log timing even on error', async () => {
        const loggerFn = mock.fn();

        const interceptor = createLoggerInterceptor({ logger: loggerFn });

        const mockReq = createMockRequest({ service: 'test.Service', method: 'Method', message: { field: 'value' } });

        const next = createMockNextError(Code.Internal, 'Test error');

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.Internal);
                return true;
            }
        );

        // Verify the failure and the timing were logged even on error: request, failure with its code, completion
        assert.strictEqual(loggerFn.mock.calls.length, 3, 'logger should be called for request, failure and timing');
        assert.strictEqual(loggerFn.mock.calls[1]!.arguments[0], 'RPC /test.Service/Method failed with Internal');
        assert.ok(
            loggerFn.mock.calls[2]!.arguments[0]?.includes('completed in'),
            'timing log should contain "completed in"'
        );
    });

    it('should log timing on exception', async () => {
        const loggerFn = mock.fn();

        const interceptor = createLoggerInterceptor({ logger: loggerFn });

        const mockReq = createMockRequest({ service: 'test.Service', method: 'Method', message: { field: 'value' } });

        const next = mock.fn(async () => {
            throw new Error('Unexpected exception');
        });

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            Error
        );

        // A plain Error is reported under the code Unknown, and the call is still closed out:
        // request, failure, completion, in this order.
        const lines = loggerFn.mock.calls.map((c: any) => c.arguments);
        assert.strictEqual(lines.length, 3);
        assert.deepStrictEqual(lines[0], ['RPC /test.Service/Method request']);
        assert.deepStrictEqual(lines[1], ['RPC /test.Service/Method failed with Unknown']);
        assert.match(lines[2]![0] as string, /^RPC \/test\.Service\/Method completed in \d+(\.\d+)?ms$/);
    });

    it('should skip health check services when skipHealthCheck=true', async () => {
        const loggerFn = mock.fn();
        const interceptor = createLoggerInterceptor({ skipHealthCheck: true, logger: loggerFn });

        const mockReq = createMockRequest({ service: 'grpc.health.v1.Health', method: 'Check' });

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

        const mockReq = createMockRequest({ service: 'grpc.health.v1.Health', method: 'Check' });

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

    // skipHealthCheck is on by default, and the match is "the service type name contains
    // grpc.health" (as documented), not an exact name.
    it('should skip health check services by default, wherever grpc.health appears in the name', async () => {
        for (const service of ['grpc.health.v1.Health', 'acme.grpc.health.v1.Probe']) {
            const loggerFn = mock.fn();
            const next = mock.fn(async () => ({ stream: false, message: {}, method: { output: {} } }));

            await createLoggerInterceptor({ logger: loggerFn })(next as any)(createMockRequest({ service, method: 'Check' }));

            assert.strictEqual(loggerFn.mock.calls.length, 0, service);
            assert.strictEqual(next.mock.calls.length, 1, service);
        }
    });

    // Without a custom logger each line goes to console[level], debug by default.
    for (const [label, options, method] of [
        ['debug by default', {}, 'debug'],
        ['info', { level: 'info' }, 'info'],
        ['warn', { level: 'warn' }, 'warn'],
        ['error', { level: 'error' }, 'error'],
    ] as const) {
        it(`should write to console.${method} when the level is ${label}`, async () => {
            const spies = Object.fromEntries((['debug', 'info', 'warn', 'error'] as const).map((name) => [name, mock.method(console, name, () => {})]));
            try {
                const next = mock.fn(async () => ({ stream: false, message: {}, method: { output: {} } }));

                await createLoggerInterceptor(options)(next as any)(createMockRequest({ service: 'test.Service', method: 'Method' }));

                for (const [name, spy] of Object.entries(spies)) {
                    assert.strictEqual(spy.mock.calls.length, name === method ? 3 : 0, `console.${name}`);
                }
            } finally {
                for (const spy of Object.values(spies)) spy.mock.restore();
            }
        });
    }

    it('should log every message of a streaming call and write the completion line last', async () => {
        const loggerFn = mock.fn();
        const interceptor = createLoggerInterceptor({ logger: loggerFn });

        async function* requestStream() {
            yield { field: 'request1' };
            yield { field: 'request2' };
        }

        async function* responseStream() {
            yield { result: 'value1' };
            yield { result: 'value2' };
        }

        // Connect hands an interceptor a streaming request and a streaming response together:
        // a streaming method never produces a unary request with a streamed response.
        const mockReq = createMockRequest({ service: 'test.Service', method: 'StreamMethod', stream: true, message: requestStream() });

        const next = mock.fn(async (req: { message: AsyncIterable<unknown> }) => {
            for await (const _ of req.message) {
                // the handler reads its whole request stream
            }
            return { stream: true, message: responseStream(), method: { output: {} } };
        });
        const handler = interceptor(next as any);

        const result = await handler(mockReq);

        // The response messages reach the reader untouched
        const items: unknown[] = [];
        for await (const item of result.message as AsyncIterable<unknown>) {
            items.push(item);
        }
        assert.deepStrictEqual(items, [{ result: 'value1' }, { result: 'value2' }]);

        // One line per streamed message, no body arguments by default, and the call is
        // closed out only after the stream has ended.
        const lines = loggerFn.mock.calls.map((call) => call.arguments);
        assert.strictEqual(lines.length, 5);
        assert.deepStrictEqual(lines.slice(0, 2), [['STREAM /test.Service/StreamMethod request'], ['STREAM /test.Service/StreamMethod request']]);
        assert.deepStrictEqual(lines.slice(2, 4), [['STREAM /test.Service/StreamMethod response'], ['STREAM /test.Service/StreamMethod response']]);
        assert.match(lines[4]![0] as string, /^RPC \/test\.Service\/StreamMethod completed in \d+(\.\d+)?ms$/);
    });

    it('should use custom logger function', async () => {
        const customLogger = mock.fn();
        const interceptor = createLoggerInterceptor({ logger: customLogger });

        const mockReq = createMockRequest({ service: 'test.Service', method: 'Method', message: { field: 'value' } });

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
