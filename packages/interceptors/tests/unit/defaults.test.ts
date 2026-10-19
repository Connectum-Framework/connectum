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
import { describe, it } from 'node:test';
import { createDefaultInterceptors } from '../../src/defaults.ts';

describe('createDefaultInterceptors', () => {
    it('should create default chain with only errorHandler and validation', () => {
        const interceptors = createDefaultInterceptors();

        // Only structural interceptors enabled by default; resilience
        // (timeout, bulkhead, circuitBreaker, retry) is opt-in
        assert.strictEqual(interceptors.length, 2);
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

    describe('interceptor chain ordering and disabling', () => {
        it('should create 2 interceptors with all defaults', () => {
            const interceptors = createDefaultInterceptors();

            assert.strictEqual(interceptors.length, 2);
            for (const ic of interceptors) {
                assert.strictEqual(typeof ic, 'function');
            }
        });

        it('should maintain correct order: errorHandler first, serializer last', () => {
            const onlyFirstLast = createDefaultInterceptors({
                errorHandler: true,
                validation: false,
                serializer: true,
            });

            assert.strictEqual(onlyFirstLast.length, 2);
            assert.strictEqual(typeof onlyFirstLast[0], 'function');
            assert.strictEqual(typeof onlyFirstLast[1], 'function');
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
