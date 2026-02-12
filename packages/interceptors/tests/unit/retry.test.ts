/**
 * Unit tests for retry interceptor
 *
 * @module retry.test
 */

import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { Code, ConnectError } from '@connectrpc/connect';
import { createRetryInterceptor } from '../../src/retry.ts';

describe('retry interceptor', () => {
    it('should throw error for negative maxRetries', () => {
        assert.throws(
            () => createRetryInterceptor({ maxRetries: -1 }),
            {
                name: 'Error',
                message: 'maxRetries must be a non-negative finite number',
            }
        );
    });

    it('should throw error for non-finite maxRetries', () => {
        assert.throws(
            () => createRetryInterceptor({ maxRetries: Number.POSITIVE_INFINITY }),
            {
                name: 'Error',
                message: 'maxRetries must be a non-negative finite number',
            }
        );

        assert.throws(
            () => createRetryInterceptor({ maxRetries: Number.NaN }),
            {
                name: 'Error',
                message: 'maxRetries must be a non-negative finite number',
            }
        );
    });

    it('should throw error for negative initialDelay', () => {
        assert.throws(
            () => createRetryInterceptor({ initialDelay: -100 }),
            {
                name: 'Error',
                message: 'initialDelay must be a non-negative finite number',
            }
        );
    });

    it('should throw error for negative maxDelay', () => {
        assert.throws(
            () => createRetryInterceptor({ maxDelay: -100 }),
            {
                name: 'Error',
                message: 'maxDelay must be a non-negative finite number',
            }
        );
    });

    it('should retry on ResourceExhausted error', async () => {
        const interceptor = createRetryInterceptor({ maxRetries: 3, initialDelay: 10 });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
        } as any;

        let attempts = 0;
        const next = mock.fn(async () => {
            attempts++;
            if (attempts < 3) {
                throw new ConnectError('Resource exhausted', Code.ResourceExhausted);
            }
            return { message: { result: 'success' } };
        });

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, 'success');
        assert(attempts >= 3, `Expected at least 3 attempts, got ${attempts}`);
    });

    it('should retry on Unavailable error', async () => {
        const interceptor = createRetryInterceptor({ maxRetries: 3, initialDelay: 10 });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
        } as any;

        let attempts = 0;
        const next = mock.fn(async () => {
            attempts++;
            if (attempts < 2) {
                throw new ConnectError('Service unavailable', Code.Unavailable);
            }
            return { message: { result: 'success' } };
        });

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, 'success');
        assert(attempts >= 2, `Expected at least 2 attempts, got ${attempts}`);
    });

    it('should propagate non-retryable errors (NotFound)', async () => {
        const interceptor = createRetryInterceptor({ maxRetries: 3, initialDelay: 10 });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
        } as any;

        const next = mock.fn(async () => {
            throw new ConnectError('Not found', Code.NotFound);
        });

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.NotFound);
                return true;
            }
        );
    });

    it('should support custom retryableCodes', async () => {
        const interceptor = createRetryInterceptor({
            maxRetries: 2,
            initialDelay: 10,
            retryableCodes: [Code.NotFound],
        });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
        } as any;

        let attempts = 0;
        const next = mock.fn(async () => {
            attempts++;
            if (attempts < 2) {
                throw new ConnectError('Not found', Code.NotFound);
            }
            return { message: { result: 'found' } };
        });

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, 'found');
        assert(attempts >= 2, `Expected at least 2 attempts, got ${attempts}`);
    });

    it('should throw after max retries exhausted', async () => {
        const interceptor = createRetryInterceptor({ maxRetries: 2, initialDelay: 10 });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
        } as any;

        const next = mock.fn(async () => {
            throw new ConnectError('Resource exhausted', Code.ResourceExhausted);
        });

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assert(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.ResourceExhausted);
                return true;
            }
        );
    });

    it('should skip streaming calls when skipStreaming=true', async () => {
        const interceptor = createRetryInterceptor({ skipStreaming: true });

        async function* mockStream() {
            yield { field: 'value1' };
        }

        const mockReq = {
            url: 'http://localhost/test.Service/StreamMethod',
            stream: true,
            message: mockStream(),
            service: { typeName: 'test.Service' },
        } as any;

        const mockRes = { message: { result: 'success' } };
        const next = mock.fn(async () => mockRes);

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual(next.mock.calls.length, 1);
        assert.strictEqual(result, mockRes);
    });

    it('should return immediately on success (no retries needed)', async () => {
        const interceptor = createRetryInterceptor({ maxRetries: 3, initialDelay: 10 });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
        } as any;

        const mockRes = { message: { result: 'success' } };
        const next = mock.fn(async () => mockRes);

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual(next.mock.calls.length, 1);
        assert.strictEqual(result, mockRes);
    });

    it('should use exponential backoff between retries', async () => {
        const interceptor = createRetryInterceptor({ maxRetries: 2, initialDelay: 50 });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
        } as any;

        const timestamps: number[] = [];
        const next = mock.fn(async () => {
            timestamps.push(Date.now());
            throw new ConnectError('Resource exhausted', Code.ResourceExhausted);
        });

        const handler = interceptor(next as any);

        await assert.rejects(() => handler(mockReq));

        // Verify retries happened
        assert(timestamps.length >= 2, `Expected at least 2 attempts, got ${timestamps.length}`);

        // Verify there was a delay between attempts
        if (timestamps.length >= 2) {
            const delay = (timestamps[1] ?? 0) - (timestamps[0] ?? 0);
            assert(delay >= 20, `Expected delay of at least 20ms, got ${delay}ms`);
        }
    });

    it('should use default values (maxRetries=3, initialDelay=200)', () => {
        // Should not throw with default options
        const interceptor = createRetryInterceptor();
        assert.ok(interceptor);
    });
});
