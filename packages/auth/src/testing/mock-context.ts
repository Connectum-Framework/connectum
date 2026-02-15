/**
 * Mock auth context for testing
 *
 * @module testing/mock-context
 */

import type { AuthContext } from "../types.ts";

/**
 * Default mock auth context values.
 */
const DEFAULT_MOCK_CONTEXT: AuthContext = {
    subject: "test-user",
    name: "Test User",
    roles: ["user"],
    scopes: ["read"],
    claims: {},
    type: "test",
};

/**
 * Create a mock AuthContext for testing.
 *
 * Merges provided overrides with sensible test defaults.
 *
 * @param overrides - Partial AuthContext to override defaults
 * @returns Complete AuthContext
 *
 * @example
 * ```typescript
 * import { createMockAuthContext } from '@connectum/auth/testing';
 *
 * const ctx = createMockAuthContext({ subject: 'admin-1', roles: ['admin'] });
 * assert.strictEqual(ctx.subject, 'admin-1');
 * assert.deepStrictEqual(ctx.roles, ['admin']);
 * assert.strictEqual(ctx.type, 'test'); // default preserved
 * ```
 */
export function createMockAuthContext(overrides?: Partial<AuthContext>): AuthContext {
    return {
        ...DEFAULT_MOCK_CONTEXT,
        ...overrides,
    };
}
