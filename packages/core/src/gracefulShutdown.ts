/**
 * Graceful Shutdown
 *
 * Orchestrates server shutdown: close transport, timeout race, execute hooks.
 *
 * @module gracefulShutdown
 */

import type { ShutdownManager } from "./ShutdownManager.ts";
import type { TransportManager } from "./TransportManager.ts";
import type { ServerLogger } from "./types.ts";

/**
 * Options for graceful shutdown behavior
 */
export interface GracefulShutdownOptions {
    timeout: number;
    forceCloseOnTimeout: boolean;
    /** Where a failed close and an exceeded timeout are reported. @default console */
    logger?: ServerLogger | undefined;
}

/**
 * Perform a graceful shutdown sequence:
 *
 * 1. Phase 2: Close the transport (stops accepting new connections, sends
 *    GOAWAY to every HTTP/2 session)
 * 2. Timeout race: wait for in-flight requests or timeout
 * 3. On timeout + forceClose: destroy every remaining connection of every
 *    transport (HTTP/2 sessions and the TCP sockets of HTTP/1.1, h2c and TLS)
 * 4. Phase 4: Execute all shutdown hooks (even after timeout -- hooks should be fast).
 *    The timeout does not bound them; if they are still running once it has
 *    elapsed, one warning names the running hooks and the elapsed time
 * 5. Dispose transport state
 *
 * Steps 4 and 5 run even when closing the transport fails: hooks release the
 * application's own resources (brokers, databases), and skipping them because
 * the listener could not close cleanly would leak exactly what the shutdown
 * exists to release. Step 4 itself is best-effort: every hook runs and is
 * awaited even when another one fails, and step 5 also runs when a hook fails.
 * Errors are re-thrown afterwards — the close error, the hook error (a single
 * failure, or an `AggregateError` of all failed hooks), or an `AggregateError`
 * with the close error and the hook error.
 *
 * @param transport - The transport manager to close
 * @param shutdownManager - The shutdown hook manager
 * @param options - Timeout and force-close configuration
 */
export async function performGracefulShutdown(transport: TransportManager, shutdownManager: ShutdownManager, options: GracefulShutdownOptions): Promise<void> {
    // _server can be null if shutdown races with startup failure or after
    // a repeated stop() call -- in both cases there's nothing to close
    if (!transport.server) return;

    const { timeout: shutdownTimeout, forceCloseOnTimeout: forceClose, logger = console } = options;

    // Phase 2: graceful close vs timeout race
    const startedAt = Date.now();
    const graceful = transport.close();

    // Catch rejected graceful promise to prevent unhandled rejection when timeout wins
    graceful.catch((err) => {
        logger.error("Error during graceful close:", err);
    });

    let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
    const timeout = new Promise<"timeout">((resolve) => {
        timer = globalThis.setTimeout(() => resolve("timeout"), shutdownTimeout);
    });

    let closeFailed = false;
    let closeError: unknown;
    let drainTimedOut = false;
    try {
        const result = await Promise.race([graceful, timeout]);

        if (result === "timeout") {
            drainTimedOut = true;
            logger.warn(`Shutdown timeout (${shutdownTimeout}ms) exceeded`);
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

    // The timeout does not bound the hooks, so a hook that never settles would hang
    // stop() without a trace. Once the timeout has elapsed and hooks are still running,
    // say so once, naming them. When the drain itself used up the timeout, the hooks get
    // the same budget from their own start, so a quick hook after a timed-out drain
    // does not raise a false alarm. Control flow is untouched: the warning only reports.
    const hooksStartedAt = Date.now();
    const warnAfter = drainTimedOut ? shutdownTimeout : Math.max(0, startedAt + shutdownTimeout - hooksStartedAt);
    const hangTimer = globalThis.setTimeout(() => {
        const running = shutdownManager.runningHooks();
        if (running.length === 0) return;
        logger.warn(
            `Shutdown timeout (${shutdownTimeout}ms) has elapsed and shutdown hooks are still running after ${Date.now() - startedAt}ms: ${running.join(", ")}. ` +
                "The timeout does not bound shutdown hooks, so stop() keeps waiting for them. Make sure each hook settles, or the orchestrator will kill the process.",
        );
    }, warnAfter);
    // A diagnostic must never keep the process alive on its own.
    hangTimer.unref?.();
    try {
        await shutdownManager.executeAll();
    } catch (err) {
        hooksFailed = true;
        hooksError = err;
    } finally {
        globalThis.clearTimeout(hangTimer);
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
