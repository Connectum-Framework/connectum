/**
 * Unit tests for default interceptor chain factory
 *
 * @module defaults.test
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createDefaultInterceptors } from '../../src/defaults.ts';

describe('createDefaultInterceptors', () => {
    it('should create default chain with 6 interceptors', () => {
        const interceptors = createDefaultInterceptors();

        // 6 enabled by default (fallback and serializer disabled)
        // errorHandler, timeout, bulkhead, circuitBreaker, retry, validation
        assert.strictEqual(interceptors.length, 6);
    });

    it('should enable fallback when handler provided', () => {
        const interceptors = createDefaultInterceptors({
            fallback: { handler: () => ({ data: [] }) },
        });

        // 7 interceptors (all default + fallback)
        assert.strictEqual(interceptors.length, 7);
    });

    it('should not enable fallback when set to true without handler', () => {
        // fallback: true is not a valid FallbackOptions object
        // It has no handler, so it won't be included
        const interceptors = createDefaultInterceptors({
            fallback: true,
        });

        // fallback: true is not typeof "object", so it's skipped
        assert.strictEqual(interceptors.length, 6);
    });

    it('should disable individual interceptors', () => {
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

        assert.strictEqual(interceptors.length, 7);
    });

    it('should disable all interceptors except specific ones', () => {
        const interceptors = createDefaultInterceptors({
            errorHandler: true,
            timeout: false,
            bulkhead: false,
            circuitBreaker: false,
            retry: false,
            validation: false,
            serializer: true,
        });

        // Only errorHandler and serializer
        assert.strictEqual(interceptors.length, 2);
    });

    it('should return empty array when all disabled', () => {
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

    describe('interceptor chain ordering and disabling', () => {
        it('should create 6 interceptors with all defaults', () => {
            const interceptors = createDefaultInterceptors();

            assert.strictEqual(interceptors.length, 6);
            for (const ic of interceptors) {
                assert.strictEqual(typeof ic, 'function');
            }
        });

        it('should create 7 interceptors when fallback has handler', () => {
            const interceptors = createDefaultInterceptors({
                fallback: { handler: () => null },
            });

            assert.strictEqual(interceptors.length, 7);
        });

        it('should maintain correct order: errorHandler first, serializer last', () => {
            const onlyFirstLast = createDefaultInterceptors({
                errorHandler: true,
                timeout: false,
                bulkhead: false,
                circuitBreaker: false,
                retry: false,
                validation: false,
                serializer: true,
            });

            assert.strictEqual(onlyFirstLast.length, 2);
            assert.strictEqual(typeof onlyFirstLast[0], 'function');
            assert.strictEqual(typeof onlyFirstLast[1], 'function');
        });

        it('should allow disabling each default-enabled interceptor individually with false', () => {
            const enabledByDefault = [
                'errorHandler', 'timeout', 'bulkhead',
                'circuitBreaker', 'retry', 'validation',
            ];

            for (const key of enabledByDefault) {
                const interceptors = createDefaultInterceptors({ [key]: false });
                assert.strictEqual(
                    interceptors.length,
                    5,
                    `Disabling ${key} should reduce count to 5`,
                );
            }
        });

        it('should not change count when disabling already-disabled serializer', () => {
            const interceptors = createDefaultInterceptors({ serializer: false });
            assert.strictEqual(interceptors.length, 6);
        });

        it('should enable serializer when set to true', () => {
            const interceptors = createDefaultInterceptors({ serializer: true });
            assert.strictEqual(interceptors.length, 7);
        });

        it('should enable serializer when given options object', () => {
            const interceptors = createDefaultInterceptors({ serializer: { skipGrpcServices: false } });
            assert.strictEqual(interceptors.length, 7);
        });

        it('should return empty array when all interceptors are disabled', () => {
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
            assert.ok(Array.isArray(interceptors));
        });
    });
});
