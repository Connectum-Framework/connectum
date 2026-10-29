/**
 * Unit tests for default interceptor chain factory
 *
 * Resilience interceptors (timeout, bulkhead, circuitBreaker, retry) are
 * opt-in: a bare createDefaultInterceptors() returns only errorHandler and
 * validation — no hidden behavioral logic.
 *
 * @module defaults.test
 */

import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { create, isMessage } from '@bufbuild/protobuf';
import type { ConnectError, Interceptor } from '@connectrpc/connect';
import { Code } from '@connectrpc/connect';
import { assertConnectError, createMockNext, createMockNextError, createMockNextSlow, createMockRequest } from '@connectum/test-fixtures';
import { EchoRequestSchema, EchoResponseSchema } from '../../../testing/tests/fixtures/validated/pb/validated/v1/validated_pb.ts';
import { createDefaultInterceptors } from '../../src/defaults.ts';

describe('createDefaultInterceptors', () => {
    it('should create exactly two interceptors by default, and the two are errorHandler then validation', async () => {
        const interceptors = createDefaultInterceptors();

        // Only structural interceptors enabled by default; resilience
        // (timeout, bulkhead, circuitBreaker, retry) is opt-in
        assert.strictEqual(interceptors.length, 2);

        // The count alone would stay green if validation were replaced by another interceptor.
        // The first one must hide the text of an unexpected failure, the second must refuse
        // an invalid request before the handler (the validated fixture requires 3+ characters).
        const SECRET = 'db-password-hunter2';
        const failing = mock.fn(async () => {
            throw new Error(SECRET);
        });
        const [errorHandler, validation] = interceptors as [Interceptor, Interceptor];
        await assert.rejects(
            () => errorHandler(failing as any)(createMockRequest({ service: 'test.Service', method: 'Method', message: {} })),
            (err: unknown) => {
                assertConnectError(err, Code.Internal);
                assert.ok(!(err as ConnectError).message.includes(SECRET), 'the text of an unexpected failure must not reach the client');
                return true;
            },
        );

        const reached = createMockNext();
        const invalid = createMockRequest({ service: 'test.Service', method: 'Method', message: create(EchoRequestSchema, { message: 'ab' }) });
        invalid.method = { name: 'Echo', input: EchoRequestSchema, output: EchoResponseSchema };
        await assert.rejects(
            async () => validation(reached as any)(invalid),
            (err: unknown) => {
                assertConnectError(err, Code.InvalidArgument);
                return true;
            },
        );
        assert.strictEqual(reached.mock.calls.length, 0, 'an invalid request must not reach the handler');
    });

    it('should not include resilience interceptors unless explicitly enabled', () => {
        const bare = createDefaultInterceptors();
        const explicit = createDefaultInterceptors({
            timeout: true,
            bulkhead: true,
            circuitBreaker: true,
            retry: true,
        });

        assert.strictEqual(bare.length, 2);
        assert.strictEqual(explicit.length, 6);
    });

    it('should enable individual resilience interceptors with true', () => {
        const resilienceKeys = ['timeout', 'bulkhead', 'circuitBreaker', 'retry'];

        for (const key of resilienceKeys) {
            const interceptors = createDefaultInterceptors({ [key]: true });
            assert.strictEqual(
                interceptors.length,
                3,
                `Enabling ${key} should increase count to 3`,
            );
        }
    });

    it('should enable individual resilience interceptors with options object', () => {
        assert.strictEqual(createDefaultInterceptors({ timeout: { duration: 10000 } }).length, 3);
        assert.strictEqual(createDefaultInterceptors({ bulkhead: { capacity: 5, queueSize: 5 } }).length, 3);
        assert.strictEqual(createDefaultInterceptors({ circuitBreaker: { threshold: 3 } }).length, 3);
        assert.strictEqual(createDefaultInterceptors({ retry: { maxRetries: 5 } }).length, 3);
    });

    it('should enable fallback when handler provided', () => {
        const interceptors = createDefaultInterceptors({
            fallback: { handler: () => ({ data: [] }) },
        });

        // errorHandler + fallback + validation
        assert.strictEqual(interceptors.length, 3);
    });

    it('should refuse fallback: true instead of silently ignoring it', () => {
        // There is no default handler, so `true` could only ever be a no-op that
        // looks like enabled graceful degradation.
        assert.throws(
            () => createDefaultInterceptors({ fallback: true as never }),
            (err: unknown) => err instanceof TypeError && err.message === 'fallback must be false or an options object with a handler, got true',
        );
    });

    it('should leave fallback disabled for fallback: false', () => {
        assert.strictEqual(createDefaultInterceptors({ fallback: false }).length, 2);
    });

    it('should refuse a fallback options object without a handler', () => {
        assert.throws(
            () => createDefaultInterceptors({ fallback: {} as never }),
            (err: unknown) => err instanceof TypeError && err.message === 'createFallbackInterceptor: handler must be a function',
        );
    });

    // A value the helper does not understand must not silently disable an interceptor:
    // `{ timeout: null }`, `{ timeout: 5000 }` or `{ timeout: "30s" }` look configured and do nothing.
    const invalidValues: ReadonlyArray<readonly [string, unknown, string]> = [
        ['null', null, 'null'],
        ['zero', 0, '0'],
        ['a number', 5000, '5000'],
        ['a string', '30s', '"30s"'],
        ['an array', [], 'an array'],
        ['a function', () => ({}), 'a function'],
    ];

    for (const key of ['errorHandler', 'timeout', 'bulkhead', 'circuitBreaker', 'retry', 'serializer']) {
        for (const [label, value, got] of invalidValues) {
            it(`should refuse ${label} for ${key} with a TypeError naming the key`, () => {
                assert.throws(
                    () => createDefaultInterceptors({ [key]: value } as never),
                    (err: unknown) => err instanceof TypeError && err.message === `${key} must be true, false or an options object, got ${got}`,
                );
            });
        }
    }

    for (const [label, value, got] of [...invalidValues, ['an object', {}, 'an object'] as const]) {
        it(`should refuse ${label} for validation, which takes only a boolean`, () => {
            assert.throws(
                () => createDefaultInterceptors({ validation: value } as never),
                (err: unknown) => err instanceof TypeError && err.message === `validation must be true or false, got ${got}`,
            );
        });
    }

    for (const [label, value, got] of invalidValues) {
        it(`should refuse ${label} for fallback with a TypeError naming the key`, () => {
            assert.throws(
                () => createDefaultInterceptors({ fallback: value } as never),
                (err: unknown) => err instanceof TypeError && err.message === `fallback must be false or an options object with a handler, got ${got}`,
            );
        });
    }

    it('should validate every key before building anything, wherever the bad key sits', () => {
        // The bad key comes after valid ones; the call still fails as a whole.
        assert.throws(
            () => createDefaultInterceptors({ timeout: true, serializer: null as never }),
            (err: unknown) => err instanceof TypeError && err.message === 'serializer must be true, false or an options object, got null',
        );
    });

    it('should surface a numeric range error from an options object', () => {
        assert.throws(
            () => createDefaultInterceptors({ timeout: { duration: 0.5 } }),
            (err: unknown) => err instanceof RangeError && err.message.startsWith('createTimeoutInterceptor: duration must be an integer'),
        );
    });

    it('should support explicit false for every interceptor', () => {
        const interceptors = createDefaultInterceptors({
            errorHandler: false,
            timeout: false,
            bulkhead: false,
            circuitBreaker: false,
            retry: false,
            validation: false,
            serializer: false,
        });

        assert.strictEqual(interceptors.length, 0);
    });

    it('should accept custom options for each interceptor', () => {
        const interceptors = createDefaultInterceptors({
            errorHandler: { logErrors: true },
            timeout: { duration: 10000 },
            bulkhead: { capacity: 5, queueSize: 5 },
            circuitBreaker: { threshold: 3, halfOpenAfter: 15000 },
            retry: { maxRetries: 5, initialDelay: 500 },
            serializer: { skipGrpcServices: false },
        });

        // errorHandler, timeout, bulkhead, circuitBreaker, retry, validation, serializer
        assert.strictEqual(interceptors.length, 7);
    });

    // The built chain is run, not counted: order and option forwarding are what
    // callers rely on, and a count cannot show either. interceptors[0] is the
    // outermost, as in Connect's applyInterceptors.
    describe('behaviour of the built chain', () => {
        const SECRET = 'db-password-hunter2';

        function compose(interceptors: Interceptor[], next: unknown): (req: unknown) => Promise<any> {
            let wrapped = next as any;
            for (const interceptor of [...interceptors].reverse()) {
                wrapped = interceptor(wrapped);
            }
            return wrapped;
        }

        function request(message: unknown = {}, stream = false) {
            return createMockRequest({ service: 'test.Service', method: 'Method', message, stream });
        }

        function validatedRequest(message: string, count = 0) {
            const req = request(create(EchoRequestSchema, { message, count }));
            req.method = { name: 'Echo', input: EchoRequestSchema, output: EchoResponseSchema };
            return req;
        }

        // The circuit breaker wraps retry: one logical call that exhausts its retries
        // is ONE breaker failure. With the two the other way round every attempt would
        // count, and the circuit would open during the first call.
        it('should wrap retry in the circuit breaker and apply the options of both', async () => {
            const chain = createDefaultInterceptors({
                retry: { maxRetries: 1, initialDelay: 1, maxDelay: 5 },
                circuitBreaker: { threshold: 2, halfOpenAfter: 60_000 },
                validation: false,
            });
            const next = createMockNextError(Code.Unavailable, 'upstream down');
            const handler = compose(chain, next);

            await assert.rejects(
                () => handler(request()),
                (err: unknown) => {
                    assertConnectError(err, Code.Unavailable, 'upstream down');
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 2, 'first logical call: one attempt and one retry');

            await assert.rejects(() => handler(request()));
            assert.strictEqual(next.mock.calls.length, 4, 'second logical call: circuit still closed after one logical failure');

            await assert.rejects(
                () => handler(request()),
                (err: unknown) => {
                    assertConnectError(err, Code.Unavailable, 'Circuit breaker is open');
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 4, 'the open circuit refuses the third call without reaching the handler');
        });

        // errorHandler is outermost: the inner interceptors see the raw failure. A
        // plain Error reaches retry as Code.Unknown, which is retried only when listed;
        // an errorHandler placed inside retry would turn it into Internal first.
        it('should put errorHandler outermost, so inner interceptors see the raw failure', async () => {
            const chain = createDefaultInterceptors({
                retry: { maxRetries: 2, initialDelay: 1, maxDelay: 5, retryableCodes: [Code.Unknown] },
                validation: false,
            });
            const next = mock.fn(async () => {
                throw new Error(`connect failed: password=${SECRET}`);
            });

            await assert.rejects(
                () => compose(chain, next)(request()),
                (err: unknown) => {
                    assertConnectError(err, Code.Internal, 'internal error');
                    assert.ok(!(err as ConnectError).rawMessage.includes(SECRET), 'the failure text must not reach the caller');
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 3, 'retry must have seen Unknown and retried twice');
        });

        it('should forward the errorHandler options', async () => {
            const chain = createDefaultInterceptors({ errorHandler: { exposeErrorMessages: true, logErrors: false }, validation: false });
            const next = mock.fn(async () => {
                throw new Error('visible text');
            });

            await assert.rejects(
                () => compose(chain, next)(request()),
                (err: unknown) => {
                    assertConnectError(err, Code.Internal, 'visible text');
                    return true;
                },
            );
        });

        it('should forward the timeout options', async () => {
            const chain = createDefaultInterceptors({ timeout: { duration: 20 }, validation: false });
            const next = createMockNextSlow(300);

            await assert.rejects(
                () => compose(chain, next)(request()),
                (err: unknown) => {
                    assertConnectError(err, Code.DeadlineExceeded, '20ms');
                    return true;
                },
            );
            // Let the abandoned slow call finish before the test ends.
            await new Promise((resolve) => setTimeout(resolve, 350));
        });

        // The timeout wraps retry: its deadline covers the whole retry sequence. With the
        // two the other way round every attempt would get a fresh deadline and a handler
        // that fails at once would never time out.
        it('should wrap retry in the timeout, so the deadline covers all retries', async () => {
            const random = mock.method(Math, 'random', () => 0.9);
            try {
                const chain = createDefaultInterceptors({
                    timeout: { duration: 60 },
                    retry: { maxRetries: 20, initialDelay: 20, maxDelay: 20 },
                    validation: false,
                });
                const next = createMockNextError(Code.Unavailable, 'upstream down');

                await assert.rejects(
                    () => compose(chain, next)(request()),
                    (err: unknown) => {
                        assertConnectError(err, Code.DeadlineExceeded, '60ms');
                        return true;
                    },
                );
                assert.ok(next.mock.calls.length < 20, `retries must stop at the deadline, but ${next.mock.calls.length} attempts were made`);
            } finally {
                random.mock.restore();
            }
        });

        it('should forward the bulkhead options', async () => {
            const chain = createDefaultInterceptors({ bulkhead: { capacity: 1, queueSize: 0 }, validation: false });
            const gate = Promise.withResolvers<void>();
            const next = mock.fn(async () => {
                await gate.promise;
                return { stream: false, message: { result: 'ok' } };
            });
            const handler = compose(chain, next);

            const first = handler(request());
            // The second call is refused at once when the options were forwarded. The gate is opened
            // after one turn so that a handler that admitted it cannot leave the test waiting forever.
            const second = handler(request()).then(
                () => 'admitted',
                (err: unknown) => err,
            );
            await new Promise((resolve) => setImmediate(resolve));
            gate.resolve();
            await first;

            const outcome = await second;
            assert.notStrictEqual(outcome, 'admitted', 'the second concurrent call must be refused');
            assertConnectError(outcome, Code.ResourceExhausted, 'Bulkhead capacity exceeded');
        });

        // fallback sits inside retry: a failure is replaced by the fallback value at
        // the first attempt, so retry never sees it. With the order reversed the
        // handler would be retried before the fallback is used.
        it('should put fallback inside retry', async () => {
            const chain = createDefaultInterceptors({
                retry: { maxRetries: 2, initialDelay: 1, maxDelay: 5 },
                fallback: { handler: () => ({ fallback: true }) },
                validation: false,
            });
            const next = createMockNextError(Code.Unavailable, 'upstream down');

            const result = await compose(chain, next)(request());

            assert.deepStrictEqual(result.message, { fallback: true });
            assert.strictEqual(next.mock.calls.length, 1);
        });

        // A request that fails validation is a client error, not a failed dependency: the
        // fallback value must not stand in for it. Validation therefore stands outside the
        // fallback, while a failure of the handler is still answered by the fallback.
        describe('validation together with fallback', () => {
            const fallbackMessage = create(EchoResponseSchema, { message: 'FALLBACK' });

            it('should reject an invalid request with InvalidArgument, calling neither the handler nor the fallback', async () => {
                const fallbackHandler = mock.fn(() => fallbackMessage);
                const next = createMockNext();

                await assert.rejects(
                    () => compose(createDefaultInterceptors({ errorHandler: { logErrors: false }, fallback: { handler: fallbackHandler } }), next)(validatedRequest('ab')),
                    (err: unknown) => {
                        assertConnectError(err, Code.InvalidArgument);
                        return true;
                    },
                );
                assert.strictEqual(next.mock.calls.length, 0, 'an invalid request must not reach the handler');
                assert.strictEqual(fallbackHandler.mock.calls.length, 0, 'the fallback must not answer a rejected request');
            });

            it('should still answer a failure of the handler with the fallback value', async () => {
                const fallbackHandler = mock.fn(() => fallbackMessage);
                const next = createMockNextError(Code.Unavailable, 'upstream down');

                const result = await compose(createDefaultInterceptors({ errorHandler: { logErrors: false }, fallback: { handler: fallbackHandler } }), next)(validatedRequest('abc'));

                assert.strictEqual(result.message, fallbackMessage);
                assert.strictEqual(next.mock.calls.length, 1);
                assert.strictEqual(fallbackHandler.mock.calls.length, 1);
            });

            it('should place validation before fallback and fallback before the serializer', async () => {
                // The order is observed through behaviour: a validation error thrown below the
                // fallback would reach the fallback handler, so it must not be called for it.
                const seen: string[] = [];
                const tag = (name: string): Interceptor => (next) => async (req) => {
                    seen.push(name);
                    return await next(req);
                };
                const chain = createDefaultInterceptors({ retry: { maxRetries: 0 }, fallback: { handler: () => fallbackMessage }, serializer: true });
                // errorHandler, retry, validation, fallback, serializer
                assert.strictEqual(chain.length, 5);
                const instrumented = [chain[0]!, chain[1]!, tag('after-retry'), chain[2]!, tag('after-validation'), chain[3]!, tag('after-fallback'), chain[4]!];

                await compose(instrumented, createMockNext())(validatedRequest('ab')).catch(() => undefined);

                assert.deepStrictEqual(seen, ['after-retry'], 'an invalid request stops at validation, before the fallback');
            });
        });

        it('should reject an invalid request with InvalidArgument before the handler by default', async () => {
            const next = createMockNext();

            await assert.rejects(
                () => compose(createDefaultInterceptors(), next)(validatedRequest('ab')),
                (err: unknown) => {
                    assertConnectError(err, Code.InvalidArgument);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0, 'an invalid request must not reach the handler');
        });

        it('should let a valid request through the default validation', async () => {
            const next = createMockNext();

            const result = await compose(createDefaultInterceptors(), next)(validatedRequest('abc'));

            assert.strictEqual((result.message as any).result, 'success');
            assert.strictEqual(next.mock.calls.length, 1);
        });

        it('should let an invalid request through when validation is disabled', async () => {
            const next = createMockNext();

            await compose(createDefaultInterceptors({ validation: false }), next)(validatedRequest('ab'));

            assert.strictEqual(next.mock.calls.length, 1);
        });

        // The serializer is innermost: validation still sees the protobuf message (a JSON
        // object would not even be validated), and only the handler receives the JSON form.
        it('should validate the protobuf request before the serializer converts it', async () => {
            const chain = createDefaultInterceptors({ serializer: { alwaysEmitImplicit: false } });
            const response = { stream: false, service: { typeName: 'test.Service' }, method: { output: EchoResponseSchema }, message: { message: 'ok' } };
            const next = mock.fn(async (_req: unknown) => response);

            await assert.rejects(
                () => compose(chain, next)(validatedRequest('ab')),
                (err: unknown) => {
                    assertConnectError(err, Code.InvalidArgument);
                    return true;
                },
            );
            assert.strictEqual(next.mock.calls.length, 0);

            // Valid request: the handler receives the JSON form, without the implicit zero count
            // because the serializer options were forwarded.
            const result = await compose(chain, next)(validatedRequest('abc'));
            assert.deepStrictEqual((next.mock.calls[0]!.arguments[0] as { message: unknown }).message, { message: 'abc' });
            assert.ok(isMessage(result.message, EchoResponseSchema), 'the response must come back as a protobuf message');
        });
    });

    describe('interceptor chain disabling', () => {
        it('should create 2 interceptors with all defaults', () => {
            const interceptors = createDefaultInterceptors();

            assert.strictEqual(interceptors.length, 2);
            for (const ic of interceptors) {
                assert.strictEqual(typeof ic, 'function');
            }
        });

        it('should allow disabling each default-enabled interceptor individually with false', () => {
            const enabledByDefault = ['errorHandler', 'validation'];

            for (const key of enabledByDefault) {
                const interceptors = createDefaultInterceptors({ [key]: false });
                assert.strictEqual(
                    interceptors.length,
                    1,
                    `Disabling ${key} should reduce count to 1`,
                );
            }
        });

        it('should not change count when disabling already-disabled serializer', () => {
            const interceptors = createDefaultInterceptors({ serializer: false });
            assert.strictEqual(interceptors.length, 2);
        });

        it('should enable serializer when set to true', () => {
            const interceptors = createDefaultInterceptors({ serializer: true });
            assert.strictEqual(interceptors.length, 3);
        });

        it('should enable serializer when given options object', () => {
            const interceptors = createDefaultInterceptors({ serializer: { skipGrpcServices: false } });
            assert.strictEqual(interceptors.length, 3);
        });

        it('should return empty array when all interceptors are disabled', () => {
            const interceptors = createDefaultInterceptors({
                errorHandler: false,
                validation: false,
            });

            assert.strictEqual(interceptors.length, 0);
            assert.ok(Array.isArray(interceptors));
        });
    });
});
