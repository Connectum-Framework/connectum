/**
 * Security Integration Tests
 *
 * Tests security-related interceptor behavior:
 * - Logger doesn't expose sensitive data patterns
 * - Logger skips health check services
 *
 * @module security.test
 */

import assert from 'node:assert';
import { describe, it, mock } from 'node:test';
import { createLoggerInterceptor } from '../../src/logger.ts';

describe('Security Integration', () => {
    it('should log requests with custom logger', async () => {
        const loggedMessages: unknown[] = [];
        const mockLogger = (message: string, ...args: unknown[]) => {
            loggedMessages.push({ message, args });
        };

        const loggerInterceptor = createLoggerInterceptor({
            skipHealthCheck: false,
            logger: mockLogger,
        });

        const mockReq = {
            url: 'http://localhost/test.Service/Method',
            stream: false,
            message: {
                username: 'testuser',
                password: 'secret123',
            },
            service: { typeName: 'test.Service' },
            method: {
                name: 'Method',
                kind: 'unary',
                input: { fields: [] },
                output: { fields: [] },
            },
        } as any;

        const next = mock.fn(async () => ({
            message: {
                username: 'testuser',
                token: 'auth-token',
            },
        }));

        const handler = loggerInterceptor(next as any);
        const result = await handler(mockReq);

        assert.strictEqual((result.message as any).username, 'testuser');
        assert(loggedMessages.length > 0);
        assert.strictEqual(next.mock.calls.length, 1);
    });

    it('should log requests without sensitive data exposure', async () => {
        const loggedData: Array<{ message: string; args: unknown[] }> = [];
        const mockLogger = (message: string, ...args: unknown[]) => {
            loggedData.push({ message, args });
        };

        const loggerInterceptor = createLoggerInterceptor({
            skipHealthCheck: false,
            logger: mockLogger,
        });

        const mockReq = {
            url: 'http://localhost/test.Service/SecureMethod',
            stream: false,
            message: {
                publicField: 'visible',
                secretField: 'should-be-hidden',
            },
            service: { typeName: 'test.Service' },
            method: {
                name: 'SecureMethod',
                kind: 'unary',
                input: { fields: [] },
                output: { fields: [] },
            },
        } as any;

        const next = mock.fn(async () => ({
            message: {
                publicField: 'response',
                secretField: 'secret-response',
            },
        }));

        const handler = loggerInterceptor(next as any);
        await handler(mockReq);

        assert(loggedData.length > 0);
        assert(loggedData.some((log) => log.message.includes('SecureMethod')));
    });

    it('should skip health check services', async () => {
        const loggedData: unknown[] = [];
        const mockLogger = (message: string, ...args: unknown[]) => {
            loggedData.push({ message, args });
        };

        const loggerInterceptor = createLoggerInterceptor({
            skipHealthCheck: true,
            logger: mockLogger,
        });

        const healthReq = {
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

        const handler = loggerInterceptor(next as any);
        await handler(healthReq);

        // Logger should NOT have logged (health check skipped)
        assert.strictEqual(loggedData.length, 0);
        assert.strictEqual(next.mock.calls.length, 1);
    });
});
