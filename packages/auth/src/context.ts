/**
 * Authentication context storage
 *
 * Uses globalThis + Symbol.for() to guarantee a single AsyncLocalStorage
 * instance per process, even when the module is evaluated multiple times
 * (e.g., tsx source + built workspace output in the same process).
 *
 * @module context
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { Code, ConnectError } from "@connectrpc/connect";
import type { AuthContext } from "./types.ts";

const STORAGE_KEY = Symbol.for("@connectum/auth/context-storage");
const META_KEY = Symbol.for("@connectum/auth/context-storage-meta");

interface StorageMeta {
    initUrl: string;
    warned: boolean;
}

function isAsyncLocalStorageLike(value: unknown): boolean {
    return (
        value != null &&
        typeof (value as Record<string, unknown>).run === "function" &&
        typeof (value as Record<string, unknown>).getStore === "function" &&
        typeof (value as Record<string, unknown>).enterWith === "function"
    );
}

function resolveStorage(): AsyncLocalStorage<AuthContext> {
    const g = globalThis as Record<symbol, unknown>;
    const existing = g[STORAGE_KEY];

    if (existing != null) {
        if (!isAsyncLocalStorageLike(existing)) {
            throw new Error("@connectum/auth: globalThis[Symbol.for('@connectum/auth/context-storage')] " + "is not an AsyncLocalStorage instance. This indicates corruption.");
        }

        // Lazy meta init (for storage created by older version without meta)
        let meta = g[META_KEY] as StorageMeta | undefined;
        if (!meta || typeof meta !== "object") {
            meta = { initUrl: "unknown (pre-meta version)", warned: false };
            try {
                g[META_KEY] = meta;
            } catch {
                /* frozen globalThis */
            }
        }

        if (!meta.warned && meta.initUrl !== import.meta.url) {
            meta.warned = true;
            if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
                process.emitWarning(
                    `Auth context storage initialized from multiple module instances. ` +
                        `First: ${meta.initUrl}, Current: ${import.meta.url}. ` +
                        `This may indicate mixed src/dist imports.`,
                    { code: "CONNECTUM_AUTH_DUP_INIT", type: "ConnectumAuthWarning" },
                );
            }
        }

        return existing as AsyncLocalStorage<AuthContext>;
    }

    // First initialization
    const storage = new AsyncLocalStorage<AuthContext>();
    try {
        g[STORAGE_KEY] = storage;
        g[META_KEY] = { initUrl: import.meta.url, warned: false } satisfies StorageMeta;
    } catch {
        throw new Error("@connectum/auth: Cannot register context storage on globalThis. " + "The global object may be frozen or non-extensible.");
    }
    return storage;
}

/**
 * Process-wide AsyncLocalStorage for auth context.
 *
 * Uses globalThis + Symbol.for() to guarantee singleton even when
 * the module is evaluated multiple times (e.g., mixed src/dist imports in dev).
 *
 * Set by auth interceptors, read by handlers via getAuthContext().
 * Automatically isolated per async context (request).
 */
export const authContextStorage = resolveStorage();

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
