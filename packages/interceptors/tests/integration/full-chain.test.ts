/**
 * Full Interceptor Chain Integration Tests
 *
 * Tests the complete interceptor chain with all interceptors working together.
 * This validates end-to-end request flow through multiple interceptors.
 *
 * @module full-chain.test
 */

import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { Code } from '@connectrpc/connect';
import { assertConnectError, createMockNextError } from '@connectum/test-fixtures';
import { createBulkheadInterceptor } from '../../src/bulkhead.ts';
import { createCircuitBreakerInterceptor } from '../../src/circuit-breaker.ts';
import { createLoggerInterceptor } from '../../src/logger.ts';
import { createRetryInterceptor } from '../../src/retry.ts';
import { createTimeoutInterceptor } from '../../src/timeout.ts';

describe('Full Interceptor Chain Integration', () => {
    it('should process request through all interceptors successfully', async () => {
        // Create complete interceptor chain
        const loggerInterceptor = createLoggerInterceptor({
            level: 'debug',
            skipHealthCheck: false,
        });

        const retryInterceptor = createRetryInterceptor({
            maxRetries: 3,
            initialDelay: 10,
        });

        const timeoutInterceptor = createTimeoutInterceptor({
            duration: 1000,
        });

        const circuitBreakerInterceptor = createCircuitBreakerInterceptor({
            threshold: 5,
        });

        const bulkheadInterceptor = createBulkheadInterceptor({
            capacity: 10,
            queueSize: 5,
        });

        // Mock request with proper structure
        const mockMethod = {
            name: 'Method',
            kind: 'unary',
            input: {
                fields: [],
                typeName: 'test.Request',
            },
            output: {
                fields: [],
                typeName: 'test.Response',
            },
        };

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            signal: new AbortController().signal,
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
            method: mockMethod,
        } as any;

        // Mock successful response with proper structure
        const expectedResponse = {
            message: { result: 'success' },
            service: { typeName: 'test.Service' },
            method: mockMethod,
            stream: false,
            header: new Headers(),
            trailer: new Headers(),
        };
        const next = mock.fn(async () => expectedResponse);

        // Chain interceptors together (right to left execution order)
        // Order: logger -> retry -> timeout -> circuit-breaker -> bulkhead -> next
        const handler = loggerInterceptor(
            retryInterceptor(
                timeoutInterceptor(
                    circuitBreakerInterceptor(
                        bulkheadInterceptor(next as any),
                    ),
                ),
            ),
        );

        // Execute request
        const result = await handler(mockReq);

        // Verify response
        assert.deepStrictEqual(result, expectedResponse);

        // Verify the actual handler was called
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it('should handle errors through the chain', async () => {
        const loggerInterceptor = createLoggerInterceptor();
        const retryInterceptor = createRetryInterceptor({
            maxRetries: 2,
            initialDelay: 10,
        });
        const circuitBreakerInterceptor = createCircuitBreakerInterceptor({
            threshold: 5,
        });

        const mockMethod = {
            name: 'FailingMethod',
            kind: 'unary',
            input: { fields: [] },
            output: { fields: [] },
        };

        const mockReq = {
            url: 'http://localhost/test.Service/FailingMethod',
            signal: new AbortController().signal,
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
            method: mockMethod,
        } as any;

        // Service always fails with ResourceExhausted (retryable error)
        const next = createMockNextError(Code.ResourceExhausted, 'Service error');

        // Chain: logger -> retry -> circuit-breaker -> next
        const handler = loggerInterceptor(
            retryInterceptor(
                circuitBreakerInterceptor(next as any),
            ),
        );

        // Should retry and eventually fail
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.ResourceExhausted);
                return true;
            },
        );

        // Verify retries happened (1 initial + 2 retries = 3 total)
        assert.strictEqual(next.mock.calls.length, 3);
    });

    it('should respect timeout in the chain', async () => {
        const timeoutInterceptor = createTimeoutInterceptor({
            duration: 50, // 50ms timeout
        });
        const retryInterceptor = createRetryInterceptor({
            maxRetries: 3,
            initialDelay: 10,
        });

        const mockReq = {
            url: 'http://localhost/test.Service/SlowMethod',
            signal: new AbortController().signal,
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
            method: {
                name: 'SlowMethod',
                kind: 'unary',
            },
        } as any;

        // Slow service (100ms delay)
        const next = mock.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { message: { result: 'too late' } };
        });

        // Chain: retry -> timeout -> next
        const handler = retryInterceptor(timeoutInterceptor(next as any));

        // Should timeout before completion
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.DeadlineExceeded);
                return true;
            },
        );

        // DeadlineExceeded is not among the default retryable codes (Unavailable, ResourceExhausted),
        // so the timed-out attempt is not repeated by the outer retry.
        assert.strictEqual(next.mock.calls.length, 1);

        // Wait for mock timers to drain
        await new Promise((resolve) => setTimeout(resolve, 150));
    });

    it('should handle bulkhead capacity limits', async () => {
        const bulkheadInterceptor = createBulkheadInterceptor({
            capacity: 2, // Only 2 concurrent requests
            queueSize: 0, // No queue
        });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            signal: new AbortController().signal,
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
            method: {
                name: 'Method',
                kind: 'unary',
            },
        } as any;

        let concurrentCalls = 0;
        let maxConcurrentCalls = 0;

        // Slow service to hold up slots
        const next = mock.fn(async () => {
            concurrentCalls++;
            maxConcurrentCalls = Math.max(maxConcurrentCalls, concurrentCalls);

            await new Promise((resolve) => setTimeout(resolve, 50));

            concurrentCalls--;
            return { message: { result: 'success' } };
        });

        const handler = bulkheadInterceptor(next as any);

        // Fire 3 concurrent requests
        const requests = [
            handler(mockReq),
            handler(mockReq),
            handler(mockReq), // This should be rejected (capacity = 2)
        ];

        // Exactly the third call is refused with ResourceExhausted; the first two complete.
        const results = await Promise.allSettled(requests);

        const rejected = results.filter((r) => r.status === 'rejected');
        assert.strictEqual(rejected.length, 1, 'Expected exactly one request to be rejected');
        assert.strictEqual(results.filter((r) => r.status === 'fulfilled').length, 2);

        // Check that rejected request has correct error
        const rejectedError = (rejected[0] as PromiseRejectedResult).reason;
        assertConnectError(rejectedError, Code.ResourceExhausted);

        // The two admitted calls ran side by side, and no third one beside them.
        assert.strictEqual(maxConcurrentCalls, 2);
    });
});
