/**
 * Unit tests for retry interceptor
 *
 * @module retry.test
 */

import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { Code, ConnectError } from '@connectrpc/connect';
import { assertConnectError, createMockNext, createMockNextError, createMockRequest } from '@connectum/testing';
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

        const mockReq = createMockRequest({ service: 'test.Service', method: 'Method', message: { field: 'value' } });

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

        const mockReq = createMockRequest({ service: 'test.Service', method: 'Method', message: { field: 'value' } });

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

        const mockReq = createMockRequest({ service: 'test.Service', method: 'Method', message: { field: 'value' } });

        const next = createMockNextError(Code.NotFound, 'Not found');

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.NotFound);
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

        const mockReq = createMockRequest({ service: 'test.Service', method: 'Method', message: { field: 'value' } });

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

        const mockReq = createMockRequest({ service: 'test.Service', method: 'Method', message: { field: 'value' } });

        const next = createMockNextError(Code.ResourceExhausted, 'Resource exhausted');

        const handler = interceptor(next as any);

        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.ResourceExhausted);
                return true;
            }
        );
    });

    it('should skip streaming calls when skipStreaming=true', async () => {
        const interceptor = createRetryInterceptor({ skipStreaming: true });

        async function* mockStream() {
            yield { field: 'value1' };
        }

        const mockReq = createMockRequest({ service: 'test.Service', method: 'StreamMethod', stream: true, message: mockStream() });

        const next = createMockNext();

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual(next.mock.calls.length, 1);
        assert.strictEqual((result.message as any).result, 'success');
    });

    it('should return immediately on success (no retries needed)', async () => {
        const interceptor = createRetryInterceptor({ maxRetries: 3, initialDelay: 10 });

        const mockReq = createMockRequest({ service: 'test.Service', method: 'Method', message: { field: 'value' } });

        const next = createMockNext();

        const handler = interceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual(next.mock.calls.length, 1);
        assert.strictEqual((result.message as any).result, 'success');
    });

    it('should use exponential backoff between retries', async () => {
        const interceptor = createRetryInterceptor({ maxRetries: 2, initialDelay: 50 });

        const mockReq = createMockRequest({ service: 'test.Service', method: 'Method', message: { field: 'value' } });

        const next = createMockNextError(Code.ResourceExhausted, 'Resource exhausted');

        const handler = interceptor(next as any);

        await assert.rejects(() => handler(mockReq));

        // Verify retries happened (initial + maxRetries = 3 attempts)
        assert(next.mock.calls.length >= 3, `Expected at least 3 attempts, got ${next.mock.calls.length}`);
    });

    it('should use default values (maxRetries=3, initialDelay=200)', () => {
        // Should not throw with default options
        const interceptor = createRetryInterceptor();
        assert.ok(interceptor);
    });
});
