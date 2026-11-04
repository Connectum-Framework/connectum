/**
 * Helpers that make a test wait for an observable event instead of a fixed pause.
 *
 * A fixed `sleep(N)` before an assertion encodes a guess about how fast the machine is; on a
 * loaded runner the awaited step simply has not happened yet. `until` polls a predicate over
 * state the test already records (an adapter call log, the observer events) and fails with a
 * named error when the deadline passes, so a genuine hang reads as "X did not happen" rather
 * than as a mismatched deepEqual. The deadline is a safety net, not an expectation: no test
 * asserts that something takes at least or at most a given time through it.
 */

/** Resolves once `predicate()` is true; rejects naming `what` if it is still false after `deadlineMs`. */
export async function until(predicate: () => boolean, what: string, deadlineMs = 5_000): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (!predicate()) {
        if (Date.now() > deadline) {
            throw new Error(`timed out after ${deadlineMs}ms waiting for: ${what}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
}

/** A promise the test opens by hand: lets a scenario hold a handler at a point until the test is ready. */
export interface Gate {
    readonly opened: Promise<void>;
    open(): void;
}

export function gate(): Gate {
    let open: () => void = () => undefined;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { opened, open };
}
