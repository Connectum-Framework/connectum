/**
 * Resilience Pattern Integration Tests
 *
 * Tests resilience interceptors working together:
 * - Retry with circuit breaker and timeout
 * - Circuit breaker opening after threshold
 * - Fallback when circuit is open
 *
 * @module resilience.test
 */

import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { Code, ConnectError } from '@connectrpc/connect';
import { assertConnectError, createMockNextError } from '@connectum/test-fixtures';
import { createCircuitBreakerInterceptor } from '../../src/circuit-breaker.ts';
import { createFallbackInterceptor } from '../../src/fallback.ts';
import { createRetryInterceptor } from '../../src/retry.ts';
import { createTimeoutInterceptor } from '../../src/timeout.ts';

describe('Resilience Pattern Integration', () => {
    it('should retry with circuit breaker and timeout', async () => {
        // Setup: retry 3 times, circuit breaker threshold 5, timeout 1s
        const retryInterceptor = createRetryInterceptor({
            maxRetries: 3,
            initialDelay: 10,
        });

        const circuitBreakerInterceptor = createCircuitBreakerInterceptor({
            threshold: 5,
        });

        const timeoutInterceptor = createTimeoutInterceptor({
            duration: 1000,
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

        let attempts = 0;
        const next = mock.fn(async () => {
            attempts++;
            // Fail first 2 times, succeed on 3rd (use ResourceExhausted for retry)
            if (attempts < 3) {
                throw new ConnectError('Service exhausted', Code.ResourceExhausted);
            }
            return { message: { result: 'success' } };
        });

        // Chain: retry -> circuit-breaker -> timeout -> next
        const handler = retryInterceptor(
            circuitBreakerInterceptor(
                timeoutInterceptor(next as any),
            ),
        );

        // Should succeed on 3rd attempt
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).result, 'success');
        assert.strictEqual(attempts, 3);

        // Circuit breaker should NOT open (only 2 failures, threshold is 5)
        assert.strictEqual(next.mock.calls.length, 3);
    });

    it('should open circuit after threshold failures', async () => {
        // Setup: circuit breaker threshold 2 (will open after 2 failures)
        const circuitBreakerInterceptor = createCircuitBreakerInterceptor({
            threshold: 2,
            halfOpenAfter: 60_000,
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

        const next = createMockNextError(Code.Internal, 'Service error');

        // Chain: circuit-breaker -> next (no retry to avoid complexity)
        const handler = circuitBreakerInterceptor(next as any);

        // First 2 requests fail with Internal error (triggers threshold)
        for (let i = 0; i < 2; i++) {
            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Internal);
                    return true;
                },
            );
        }

        // Circuit should be open now
        // Third request should fail immediately with Unavailable (circuit open)
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.Unavailable, 'Circuit breaker is open');
                return true;
            },
        );

        // Verify: first 2 requests made calls, third was blocked by circuit
        assert.strictEqual(next.mock.calls.length, 2);
    });

    it('should fallback when circuit open', async () => {
        // Setup: circuit breaker threshold 2, fallback returns cached data
        const circuitBreakerInterceptor = createCircuitBreakerInterceptor({
            threshold: 2,
            halfOpenAfter: 60_000, // large value to keep circuit open during test
        });

        const fallbackInterceptor = createFallbackInterceptor({
            handler: (error) => {
                console.debug('Fallback activated:', error.message);
                return { result: 'cached data' };
            },
            skipStreaming: true,
        });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            header: new Headers(),
            signal: new AbortController().signal,
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
            method: {
                name: 'Method',
                kind: 'unary',
            },
        } as any;

        const next = createMockNextError(Code.Internal, 'Service error');

        // Chain: fallback -> circuit-breaker -> next
        const handler = fallbackInterceptor(circuitBreakerInterceptor(next as any));

        // First 2 requests: trigger circuit breaker opening
        for (let i = 0; i < 2; i++) {
            const result = await handler(mockReq);
            // Fallback should return cached data
            assert.strictEqual((result.message as any).result, 'cached data');
        }

        // Third request: circuit is open, fallback returns cached data
        const result = await handler(mockReq);
        assert.strictEqual((result.message as any).result, 'cached data');

        // Verify: circuit breaker allowed only 2 calls before opening
        assert.strictEqual(next.mock.calls.length, 2);
    });

    it('should propagate timeout error through retry chain', async () => {
        const timeoutInterceptor = createTimeoutInterceptor({
            duration: 30, // 30ms timeout
        });

        // Retrying DeadlineExceeded is opt-in (it is not a default retryable code), so the
        // timeout is attempted again on purpose here: 1 initial attempt + 2 retries.
        const retryInterceptor = createRetryInterceptor({
            maxRetries: 2,
            initialDelay: 10,
            retryableCodes: [Code.DeadlineExceeded],
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

        const next = mock.fn(async () => {
            // Always slow (will timeout)
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { message: { result: 'too late' } };
        });

        // Chain: retry -> timeout -> next
        const handler = retryInterceptor(timeoutInterceptor(next as any));

        // After the last retry the timeout error of the last attempt reaches the caller
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.DeadlineExceeded, '30ms');
                return true;
            },
        );
        assert.strictEqual(next.mock.calls.length, 3);

        // Wait for mock timers to drain
        await new Promise((resolve) => setTimeout(resolve, 100));
    });

    it('should combine retry, timeout, circuit breaker, and fallback', async () => {
        // Complete resilience stack
        const retryInterceptor = createRetryInterceptor({
            maxRetries: 1,
            initialDelay: 10,
        });

        const timeoutInterceptor = createTimeoutInterceptor({
            duration: 50,
        });

        const circuitBreakerInterceptor = createCircuitBreakerInterceptor({
            threshold: 2,
            halfOpenAfter: 300,
        });

        // The fallback records which error each of the three calls ended with
        const failureCodes: Code[] = [];
        const fallbackInterceptor = createFallbackInterceptor({
            handler: (error) => {
                failureCodes.push(ConnectError.from(error).code);
                return { result: 'fallback response' };
            },
        });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            header: new Headers(),
            signal: new AbortController().signal,
            stream: false,
            message: { field: 'value' },
            service: { typeName: 'test.Service' },
            method: {
                name: 'Method',
                kind: 'unary',
            },
        } as any;

        // Service is always slow (will timeout)
        const next = mock.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { message: { result: 'never reached' } };
        });

        // Chain: fallback -> retry -> circuit-breaker -> timeout -> next
        const handler = fallbackInterceptor(
            retryInterceptor(
                circuitBreakerInterceptor(
                    timeoutInterceptor(next as any),
                ),
            ),
        );

        // First call: the timeout fires (DeadlineExceeded). That code is not retryable by default, so the
        // downstream is tried once; the breaker counts one failure of two and stays closed.
        const result1 = await handler(mockReq);
        assert.strictEqual((result1.message as any).result, 'fallback response');
        assert.strictEqual(next.mock.calls.length, 1);

        // Second call: the breaker is still closed, the timeout fires again and this second
        // consecutive failure opens it.
        const result2 = await handler(mockReq);
        assert.strictEqual((result2.message as any).result, 'fallback response');
        assert.strictEqual(next.mock.calls.length, 2);

        // Third call: the open circuit refuses (Unavailable, which retry does repeat once, and the breaker
        // refuses again) without reaching the downstream; the fallback still answers.
        const result3 = await handler(mockReq);
        assert.strictEqual((result3.message as any).result, 'fallback response');
        assert.strictEqual(next.mock.calls.length, 2);

        assert.deepStrictEqual(failureCodes, [Code.DeadlineExceeded, Code.DeadlineExceeded, Code.Unavailable]);

        // Wait for mock timers and halfOpenAfter timer to drain
        await new Promise((resolve) => setTimeout(resolve, 400));
    });

    it('should handle streaming requests correctly', async () => {
        // All resilience interceptors should skip streaming by default
        const retryInterceptor = createRetryInterceptor({ skipStreaming: true, initialDelay: 1, maxDelay: 5 });
        const timeoutInterceptor = createTimeoutInterceptor({ skipStreaming: true });
        // Threshold 1: a single failure seen by the breaker would open it
        const circuitBreakerInterceptor = createCircuitBreakerInterceptor({ skipStreaming: true, threshold: 1 });
        const fallbackInterceptor = createFallbackInterceptor({
            handler: () => ({ result: 'fallback' }),
            skipStreaming: true,
        });

        const streamingReq = {
            url: 'http://localhost/test.Service/StreamMethod',
            signal: new AbortController().signal,
            stream: true, // Streaming request
            message: {},
            service: { typeName: 'test.Service' },
            method: {
                name: 'StreamMethod',
                kind: 'server_streaming',
            },
        } as any;

        // A retryable failure: retry would repeat it, the breaker (threshold 1) would open on it,
        // and the fallback would replace it with a substitute response.
        const failure = new ConnectError('Service unavailable', Code.Unavailable);
        const next = mock.fn(async () => {
            throw failure;
        });

        // Chain all resilience interceptors
        const handler = fallbackInterceptor(
            retryInterceptor(
                circuitBreakerInterceptor(
                    timeoutInterceptor(next as any),
                ),
            ),
        );

        // Every streaming call reaches the downstream exactly once and fails with its own error
        for (let i = 1; i <= 2; i++) {
            await assert.rejects(
                () => handler(streamingReq),
                (err: unknown) => err === failure,
            );
            assert.strictEqual(next.mock.calls.length, i);
        }
    });
});
