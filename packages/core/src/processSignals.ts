/**
 * Process signal subscriptions shared by every server in the process.
 *
 * A server with `autoShutdown` reacts to termination signals. Registering one
 * `process.on(signal, ...)` listener per server makes Node.js warn about a
 * possible EventEmitter leak (`MaxListenersExceededWarning`) once eleven servers
 * are started in the same process, as test suites and multi-server processes
 * do, although every listener is removed again on `stop()`. All servers therefore
 * share one process listener per signal, which hands the signal to each
 * subscribed server and is removed when the last one unsubscribes.
 *
 * @module processSignals
 */

type SignalHandler = () => void;

/** Subscribed handlers per signal, in subscription order. */
const subscribers = new Map<NodeJS.Signals, Set<SignalHandler>>();

/** The one `process` listener installed for each signal that has subscribers. */
const dispatchers = new Map<NodeJS.Signals, SignalHandler>();

/**
 * Call `handler` whenever the process receives `signal`.
 *
 * @returns A function that ends the subscription. It is idempotent.
 *
 * @internal
 */
export function onProcessSignal(signal: NodeJS.Signals, handler: SignalHandler): () => void {
    let handlers = subscribers.get(signal);
    if (!handlers) {
        const current = new Set<SignalHandler>();
        handlers = current;
        subscribers.set(signal, current);
        const dispatch = () => {
            // A copy: a handler may unsubscribe itself (or another server) while the signal is dispatched.
            for (const subscribed of [...current]) {
                subscribed();
            }
        };
        dispatchers.set(signal, dispatch);
        process.on(signal, dispatch);
    }
    handlers.add(handler);

    return () => {
        const current = subscribers.get(signal);
        if (!current?.delete(handler) || current.size > 0) {
            return;
        }
        const dispatch = dispatchers.get(signal);
        if (dispatch) {
            process.removeListener(signal, dispatch);
        }
        subscribers.delete(signal);
        dispatchers.delete(signal);
    };
}
