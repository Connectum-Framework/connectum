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
import { Code, ConnectError } from '@connectrpc/connect';
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
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
            method: mockMethod,
        } as any;

        // Service always fails with ResourceExhausted (retryable error)
        const next = mock.fn(async () => {
            throw new ConnectError('Service error', Code.ResourceExhausted);
        });

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
                assert(err instanceof ConnectError);
                assert.strictEqual((err as ConnectError).code, Code.ResourceExhausted);
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
                assert(err instanceof ConnectError);
                // Timeout should result in DeadlineExceeded
                assert.strictEqual((err as ConnectError).code, Code.DeadlineExceeded);
                return true;
            },
        );
    });

    it('should handle bulkhead capacity limits', async () => {
        const bulkheadInterceptor = createBulkheadInterceptor({
            capacity: 2, // Only 2 concurrent requests
            queueSize: 0, // No queue
        });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
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

        // At least one should fail with ResourceExhausted
        const results = await Promise.allSettled(requests);

        const rejected = results.filter((r) => r.status === 'rejected');
        assert(rejected.length > 0, 'Expected at least one request to be rejected');

        // Check that rejected request has correct error
        const rejectedError = (rejected[0] as PromiseRejectedResult).reason;
        assert(rejectedError instanceof ConnectError);
        assert.strictEqual(rejectedError.code, Code.ResourceExhausted);

        // Max concurrent calls should not exceed capacity
        assert(maxConcurrentCalls <= 2, `Max concurrent calls ${maxConcurrentCalls} exceeded capacity 2`);
    });

    it('should skip health check services when configured', async () => {
        const loggerInterceptor = createLoggerInterceptor({
            skipHealthCheck: true,
        });
        const retryInterceptor = createRetryInterceptor({
            maxRetries: 3,
        });

        // Health check request
        const healthCheckReq = {
            url: 'http://localhost/grpc.health.v1.Health/Check',
            stream: false,
            message: {},
            service: { typeName: 'grpc.health.v1.Health' },
            method: {
                name: 'Check',
                kind: 'unary',
            },
        } as any;

        const next = mock.fn(async () => ({
            message: { status: 'SERVING' },
        }));

        const handler = loggerInterceptor(retryInterceptor(next as any));

        const result = await handler(healthCheckReq);

        assert.strictEqual((result.message as any).status, 'SERVING');
        assert.strictEqual(next.mock.calls.length, 1);
    });
});
