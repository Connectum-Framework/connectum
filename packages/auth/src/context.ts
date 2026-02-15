/**
 * Authentication context storage
 *
 * Uses AsyncLocalStorage to make auth context available to handlers
 * without passing it through function parameters.
 *
 * @module context
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Code, ConnectError } from "@connectrpc/connect";
import type { AuthContext } from "./types.ts";

/**
 * Module-level AsyncLocalStorage for auth context.
 *
 * Set by auth interceptors, read by handlers via getAuthContext().
 * Automatically isolated per async context (request).
 */
export const authContextStorage = new AsyncLocalStorage<AuthContext>();

/**
 * Get the current auth context.
 *
 * Returns the AuthContext set by the auth interceptor in the current
 * async context. Returns undefined if no auth interceptor is active
 * or the current method was skipped.
 *
 * @returns Current auth context or undefined
 *
 * @example Usage in a service handler
 * ```typescript
 * import { getAuthContext } from '@connectum/auth';
 *
 * const handler = {
 *   async getUser(req) {
 *     const auth = getAuthContext();
 *     if (!auth) throw new ConnectError('Not authenticated', Code.Unauthenticated);
 *     return { user: await db.getUser(auth.subject) };
 *   },
 * };
 * ```
 */
export function getAuthContext(): AuthContext | undefined {
    return authContextStorage.getStore();
}

/**
 * Get the current auth context or throw.
 *
 * Like getAuthContext() but throws ConnectError(Code.Unauthenticated)
 * if no auth context is available. Use when auth is mandatory.
 *
 * @returns Current auth context (never undefined)
 * @throws ConnectError with Code.Unauthenticated if no context
 */
export function requireAuthContext(): AuthContext {
    const context = authContextStorage.getStore();
    if (!context) {
        throw new ConnectError("Authentication required", Code.Unauthenticated);
    }
    return context;
}
