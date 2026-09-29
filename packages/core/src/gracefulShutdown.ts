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
 * 1. Phase 2: Close the transport (stops accepting new connections, sends
 *    GOAWAY to every HTTP/2 session)
 * 2. Timeout race: wait for in-flight requests or timeout
 * 3. On timeout + forceClose: destroy every remaining connection of every
 *    transport (HTTP/2 sessions and the TCP sockets of HTTP/1.1, h2c and TLS)
 * 4. Phase 4: Execute all shutdown hooks (even after timeout -- hooks should be fast)
 * 5. Dispose transport state
 *
 * Steps 4 and 5 run even when closing the transport fails: hooks release the
 * application's own resources (brokers, databases), and skipping them because
 * the listener could not close cleanly would leak exactly what the shutdown
 * exists to release. Step 5 also runs when a hook fails. Errors are re-thrown
 * afterwards — the close error, the hook error, or an `AggregateError` with
 * both.
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

    let closeFailed = false;
    let closeError: unknown;
    try {
        const result = await Promise.race([graceful, timeout]);

        if (result === "timeout") {
            console.warn(`Shutdown timeout (${shutdownTimeout}ms) exceeded`);
            if (forceClose) {
                transport.destroyAllSessions();
            }
        }
    } catch (err) {
        closeFailed = true;
        closeError = err;
    } finally {
        if (timer !== undefined) {
            globalThis.clearTimeout(timer);
        }
    }

    // Phase 4: Execute shutdown hooks (even after timeout -- hooks should be fast).
    // Disposal must not depend on the hooks succeeding either.
    let hooksFailed = false;
    let hooksError: unknown;
    try {
        await shutdownManager.executeAll();
    } catch (err) {
        hooksFailed = true;
        hooksError = err;
    } finally {
        transport.dispose();
    }

    // Report every failure: when both steps failed, neither error may hide
    // the other.
    if (closeFailed && hooksFailed) {
        throw new AggregateError([closeError, hooksError], "Shutdown failed: the transport did not close and a shutdown hook failed");
    }
    if (closeFailed) {
        throw closeError;
    }
    if (hooksFailed) {
        throw hooksError;
    }
}
