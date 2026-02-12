/**
 * Graceful Shutdown
 *
 * Orchestrates server shutdown: close transport, timeout race, execute hooks.
 *
 * @module gracefulShutdown
 */

import type { ShutdownManager } from "./ShutdownManager.ts";
import type { TransportManager } from "./TransportManager.ts";

/**
 * Options for graceful shutdown behavior
 */
export interface GracefulShutdownOptions {
    timeout: number;
    forceCloseOnTimeout: boolean;
}

/**
 * Perform a graceful shutdown sequence:
 *
 * 1. Phase 2: Close the transport (sends GOAWAY, stops accepting new connections)
 * 2. Timeout race: wait for in-flight requests or timeout
 * 3. On timeout + forceClose: destroy all HTTP/2 sessions
 * 4. Phase 4: Execute all shutdown hooks (even after timeout -- hooks should be fast)
 * 5. Dispose transport state
 *
 * @param transport - The transport manager to close
 * @param shutdownManager - The shutdown hook manager
 * @param options - Timeout and force-close configuration
 */
export async function performGracefulShutdown(transport: TransportManager, shutdownManager: ShutdownManager, options: GracefulShutdownOptions): Promise<void> {
    // _server can be null if shutdown races with startup failure or after
    // a repeated stop() call -- in both cases there's nothing to close
    if (!transport.server) return;

    const { timeout: shutdownTimeout, forceCloseOnTimeout: forceClose } = options;

    // Phase 2: graceful close vs timeout race
    const graceful = transport.close();

    // Catch rejected graceful promise to prevent unhandled rejection when timeout wins
    graceful.catch((err) => {
        console.error("Error during graceful close:", err);
    });

    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
        timer = globalThis.setTimeout(() => resolve("timeout"), shutdownTimeout);
    });

    try {
        const result = await Promise.race([graceful, timeout]);

        if (result === "timeout") {
            console.warn(`Shutdown timeout (${shutdownTimeout}ms) exceeded`);
            if (forceClose) {
                transport.destroyAllSessions();
            }
        }
    } finally {
        if (timer !== undefined) {
            globalThis.clearTimeout(timer);
        }
    }

    // Phase 4: Execute shutdown hooks (even after timeout -- hooks should be fast)
    await shutdownManager.executeAll();

    transport.dispose();
}
