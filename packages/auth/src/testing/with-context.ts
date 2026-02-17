/**
 * Auth context test helper
 *
 * @module testing/with-context
 */

import { authContextStorage } from "../context.ts";
import type { AuthContext } from "../types.ts";

/**
 * Run a function with a pre-set AuthContext.
 *
 * Sets the provided AuthContext in AsyncLocalStorage for the duration
 * of the callback. Useful for testing handlers that call getAuthContext().
 *
 * @param context - Auth context to set
 * @param fn - Function to execute within the context
 * @returns Return value of fn
 *
 * @example Test a handler that reads auth context
 * ```typescript
 * import { withAuthContext, createMockAuthContext } from '@connectum/auth/testing';
 * import { getAuthContext } from '@connectum/auth';
 *
 * await withAuthContext(createMockAuthContext({ subject: 'test-user' }), async () => {
 *   const ctx = getAuthContext();
 *   assert.strictEqual(ctx?.subject, 'test-user');
 * });
 * ```
 */
export async function withAuthContext<T>(context: AuthContext, fn: () => T | Promise<T>): Promise<T> {
    return await authContextStorage.run(context, fn);
}
