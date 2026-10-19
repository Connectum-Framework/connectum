/**
 * Unit tests for retry interceptor
 *
 * @module retry.test
 */

import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { Code, ConnectError } from '@connectrpc/connect';
import { assertConnectError, createMockNext, createMockNextError, createMockRequest } from '@connectum/test-fixtures';
import { createRetryInterceptor } from '../../src/retry.ts';

describe('retry interceptor', () => {
    // maxRetries is documented as a "non-negative finite number" of retries after the initial attempt.
    for (const [label, value] of [
        ['negative', -1],
        ['negative fractional', -0.5],
        ['negative infinite', Number.NEGATIVE_INFINITY],
        ['positive infinite', Number.POSITIVE_INFINITY],
        ['NaN', Number.NaN],
    ] as const) {
        it(`should throw a RangeError for ${label} maxRetries`, () => {
            assert.throws(
                () => createRetryInterceptor({ maxRetries: value }),
                {
                    name: 'RangeError',
                    message: new RegExp(`^createRetryInterceptor: maxRetries must be a finite number of at least 0, got ${String(value)}$`),
                }
            );
        });
    }

    // The boundary of the same documented range: zero and fractional values are valid.
    // The retry count is compared as is, so 0 retries means a single attempt and 0.5 allows one retry.
    for (const [maxRetries, expectedAttempts] of [
        [0, 1],
        [0.5, 2],
    ] as const) {
        it(`should accept maxRetries ${maxRetries} and make ${expectedAttempts} attempt(s) in total`, async () => {
            const interceptor = createRetryInterceptor({ maxRetries, initialDelay: 1, maxDelay: 5 });
            const mockReq = createMockRequest({ service: 'test.Service', method: 'Method', message: { field: 'value' } });
            const next = createMockNextError(Code.Unavailable, 'Service unavailable');

            await assert.rejects(
                () => interceptor(next as any)(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Unavailable);
                    return true;
                }
            );

            assert.strictEqual(next.mock.calls.length, expectedAttempts);
        });
    }

    for (const option of ['initialDelay', 'maxDelay'] as const) {
        for (const [label, value, got] of [
            ['negative', -100, '-100'],
            ['infinite', Number.POSITIVE_INFINITY, 'Infinity'],
            ['NaN', Number.NaN, 'NaN'],
            ['fractional', 0.5, '0.5'],
            ['above the timer ceiling', 2_147_483_648, '2147483648'],
        ] as const) {
            it(`should refuse a ${label} ${option} with a RangeError naming the option and the value`, () => {
                assert.throws(
                    () => createRetryInterceptor({ [option]: value }),
                    (err: unknown) =>
                        err instanceof RangeError &&
                        err.message === `createRetryInterceptor: ${option} must be an integer from 0 to 2147483647 milliseconds, got ${got}`,
                );
            });
        }

        it(`should accept the boundary ${option} values 0 and 2147483647`, () => {
            assert.strictEqual(typeof createRetryInterceptor({ [option]: 0 }), 'function');
            assert.strictEqual(typeof createRetryInterceptor({ [option]: 2_147_483_647 }), 'function');
        });
    }

    it('should refuse non-number options with a TypeError', () => {
        assert.throws(
            () => createRetryInterceptor({ maxRetries: '3' as unknown as number }),
            (err: unknown) => err instanceof TypeError && err.message === 'createRetryInterceptor: maxRetries must be a finite number of at least 0, got "3"',
        );
        assert.throws(
            () => createRetryInterceptor({ initialDelay: null as unknown as number }),
            (err: unknown) =>
                err instanceof TypeError && err.message === 'createRetryInterceptor: initialDelay must be an integer from 0 to 2147483647 milliseconds, got null',
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

        // NotFound is not in the default retryable codes: one attempt, no retries
        assert.strictEqual(next.mock.calls.length, 1);
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

        // maxRetries counts retries after the initial attempt: 1 + 2 attempts
        assert.strictEqual(next.mock.calls.length, 3);
    });

    it('should skip streaming calls when skipStreaming=true', async () => {
        const interceptor = createRetryInterceptor({ skipStreaming: true, initialDelay: 1, maxDelay: 5 });

        async function* mockStream() {
            yield { field: 'value1' };
        }

        const mockReq = createMockRequest({ service: 'test.Service', method: 'StreamMethod', stream: true, message: mockStream() });

        // A retryable failure: a streaming call that went through the retry loop would be attempted again
        const next = createMockNextError(Code.Unavailable, 'Service unavailable');

        const handler = interceptor(next as any);
        await assert.rejects(
            () => handler(mockReq),
            (err: unknown) => {
                assertConnectError(err, Code.Unavailable);
                return true;
            }
        );

        assert.strictEqual(next.mock.calls.length, 1);
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

    it('should wait between retries and never longer than maxDelay', async () => {
        // The delays are randomized (decorrelated jitter, scale initialDelay), so the random source is
        // pinned. With a scale of 400 ms far above maxDelay the delay reaches its cap, which makes
        // every wait equal to maxDelay: a retry without any wait, or a wait that ignores the cap
        // (about 500 ms and more at this scale), both leave the window below.
        const maxDelay = 30;
        const random = mock.method(Math, 'random', () => 0.9);
        try {
            const interceptor = createRetryInterceptor({ maxRetries: 3, initialDelay: 400, maxDelay });

            const mockReq = createMockRequest({ service: 'test.Service', method: 'Method', message: { field: 'value' } });

            const attemptTimes: number[] = [];
            const next = mock.fn(async () => {
                attemptTimes.push(performance.now());
                throw new ConnectError('Resource exhausted', Code.ResourceExhausted);
            });

            const handler = interceptor(next as any);

            await assert.rejects(() => handler(mockReq));

            // initial attempt + maxRetries
            assert.strictEqual(attemptTimes.length, 4);
            for (let i = 1; i < attemptTimes.length; i++) {
                const wait = attemptTimes[i]! - attemptTimes[i - 1]!;
                assert.ok(wait >= maxDelay - 5, `wait before retry ${i} was ${wait} ms, expected about ${maxDelay} ms`);
                assert.ok(wait <= maxDelay + 120, `wait before retry ${i} was ${wait} ms, expected at most maxDelay (${maxDelay} ms)`);
            }
        } finally {
            random.mock.restore();
        }
    });

    it('should use default values (maxRetries=3, initialDelay=200)', () => {
        // Should not throw with default options
        const interceptor = createRetryInterceptor();
        assert.ok(interceptor);
    });

    describe('additional retry scenarios', () => {
        it('should preserve non-retryable code (InvalidArgument) after retries', async () => {
            const interceptor = createRetryInterceptor({ maxRetries: 3, initialDelay: 10 });

            const mockReq = createMockRequest({
                service: 'test.Service',
                method: 'Method',
                message: { field: 'value' },
            });

            const next = createMockNextError(Code.InvalidArgument, 'Invalid argument');

            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.InvalidArgument);
                    return true;
                },
            );

            assert.strictEqual(next.mock.calls.length, 1, 'should not retry non-retryable errors');
        });

        it('should throw the last error after exhausting all retries', async () => {
            const interceptor = createRetryInterceptor({ maxRetries: 2, initialDelay: 10 });

            const mockReq = createMockRequest({
                service: 'test.Service',
                method: 'Method',
                message: { field: 'value' },
            });

            let attempt = 0;
            const next = mock.fn(async () => {
                attempt++;
                throw new ConnectError(`Unavailable attempt ${attempt}`, Code.Unavailable);
            });

            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Unavailable);
                    assert.ok(err instanceof ConnectError);
                    // The error of the final attempt is the one that reaches the caller, not the first one
                    assert.strictEqual(err.rawMessage, 'Unavailable attempt 3');
                    return true;
                },
            );

            // initial attempt + maxRetries = 3 total
            assert.strictEqual(next.mock.calls.length, 3, `Expected 3 attempts, got ${next.mock.calls.length}`);
        });

        it('should retry on custom retryable code and succeed after recovery', async () => {
            let attempts = 0;
            const interceptor = createRetryInterceptor({
                maxRetries: 3,
                initialDelay: 10,
                retryableCodes: [Code.Aborted],
            });

            const mockReq = createMockRequest({
                service: 'test.Service',
                method: 'Method',
                message: { field: 'value' },
            });

            const next = mock.fn(async () => {
                attempts++;
                if (attempts < 3) {
                    throw new ConnectError('Aborted', Code.Aborted);
                }
                return { message: { result: 'recovered' } };
            });

            const handler = interceptor(next as any);
            const result = await handler(mockReq);

            assert.strictEqual((result.message as any).result, 'recovered');
            assert.strictEqual(attempts, 3, `Expected 3 attempts, got ${attempts}`);
        });

        it('should pass through streaming request when skipStreaming=true (default)', async () => {
            const interceptor = createRetryInterceptor({
                maxRetries: 3,
                initialDelay: 10,
                skipStreaming: true,
            });

            const mockReq = createMockRequest({
                service: 'test.Service',
                method: 'StreamMethod',
                stream: true,
                message: { field: 'value' },
            });

            const next = createMockNextError(Code.Unavailable, 'Service unavailable');

            const handler = interceptor(next as any);

            await assert.rejects(
                () => handler(mockReq),
                (err: unknown) => {
                    assertConnectError(err, Code.Unavailable);
                    return true;
                },
            );

            // Should only be called once (no retry for streaming)
            assert.strictEqual(next.mock.calls.length, 1, 'should not retry streaming calls');
        });
    });
});
