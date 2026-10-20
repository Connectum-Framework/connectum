/**
 * Security Integration Tests
 *
 * Tests security-related interceptor behavior:
 * - Logger doesn't expose sensitive data patterns
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
        assert.strictEqual(next.mock.calls.length, 1);

        // Every line of the call goes to the custom logger (not to the console), and with bodies
        // off none carries an argument: request, response, completion, in this order.
        const entries = loggedMessages as Array<{ message: string; args: unknown[] }>;
        assert.deepStrictEqual(
            entries.map((entry) => entry.args),
            [[], [], []],
        );
        assert.strictEqual(entries[0]!.message, 'RPC /test.Service/Method request');
        assert.strictEqual(entries[1]!.message, 'RPC /test.Service/Method response');
        assert.match(entries[2]!.message, /^RPC \/test\.Service\/Method completed in \d+(\.\d+)?ms$/);
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

        assert.deepStrictEqual(
            loggedData.map((log) => [log.message.replace(/completed in .*/, 'completed in <ms>'), log.args]),
            [
                ['RPC /test.Service/SecureMethod request', []],
                ['RPC /test.Service/SecureMethod response', []],
                ['RPC /test.Service/SecureMethod completed in <ms>', []],
            ],
        );
        assert(!JSON.stringify(loggedData).includes('should-be-hidden'), 'request body must not reach the log by default');
        assert(!JSON.stringify(loggedData).includes('secret-response'), 'response body must not reach the log by default');
    });
});
