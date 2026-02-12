/**
 * Unit tests for default interceptor chain factory
 *
 * @module defaults.test
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { createDefaultInterceptors } from '../../src/defaults.ts';

describe('createDefaultInterceptors', () => {
    it('should create default chain with 8 interceptors', () => {
        const interceptors = createDefaultInterceptors();

        // 7 enabled by default (fallback disabled)
        // errorHandler, timeout, bulkhead, circuitBreaker, retry, validation, serializer
        assert.strictEqual(interceptors.length, 7);
    });

    it('should enable fallback when handler provided', () => {
        const interceptors = createDefaultInterceptors({
            fallback: { handler: () => ({ data: [] }) },
        });

        // 8 interceptors (all including fallback)
        assert.strictEqual(interceptors.length, 8);
    });

    it('should not enable fallback when set to true without handler', () => {
        // fallback: true is not a valid FallbackOptions object
        // It has no handler, so it won't be included
        const interceptors = createDefaultInterceptors({
            fallback: true,
        });

        // fallback: true is not typeof "object", so it's skipped
        assert.strictEqual(interceptors.length, 7);
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
});
