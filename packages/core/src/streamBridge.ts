/**
 * Push-to-pull bridge for `ctx.stream`.
 *
 * ConnectRPC v2 streaming clients are pull-based: `transport.stream` consumes
 * an `AsyncIterable<I>` of inputs. The catalog `ctx.stream` API is push-based
 * (`handle.send(req)` / `handle.close()`), so for client- and bidi-streaming we
 * bridge a push interface onto a lazily-consumed `AsyncIterable` via a small
 * single-consumer queue with backpressure-free buffering.
 *
 * @module streamBridge
 */

/**
 * A push interface paired with the `AsyncIterable` that `transport.stream`
 * consumes. `push` enqueues an input; `close` ends the input stream; `fail`
 * makes the iterable throw (used to surface an abort/error to the server).
 *
 * @internal
 */
export interface InputQueue<T> {
    push(value: T): void;
    close(): void;
    fail(error: unknown): void;
    readonly iterable: AsyncIterable<T>;
}

/**
 * Create a single-consumer push-to-pull input queue. Buffered values are
 * drained before a `close()`/`fail()` takes effect, so no input is lost.
 *
 * @internal
 */
export function createInputQueue<T>(): InputQueue<T> {
    const buffer: T[] = [];
    let closed = false;
    let failure: { error: unknown } | null = null;
    let notify: (() => void) | null = null;

    const wake = (): void => {
        const resume = notify;
        if (resume !== null) {
            notify = null;
            resume();
        }
    };

    const iterable: AsyncIterable<T> = {
        async *[Symbol.asyncIterator]() {
            while (true) {
                if (buffer.length > 0) {
                    yield buffer.shift() as T;
                    continue;
                }
                if (failure !== null) throw failure.error;
                if (closed) return;
                await new Promise<void>((resolve) => {
                    notify = resolve;
                });
            }
        },
    };

    return {
        push(value: T): void {
            if (closed || failure !== null) return;
            buffer.push(value);
            wake();
        },
        close(): void {
            closed = true;
            wake();
        },
        fail(error: unknown): void {
            if (failure === null) failure = { error };
            closed = true;
            wake();
        },
        iterable,
    };
}

/**
 * Wrap a single value as a one-shot `AsyncIterable` — the input for a
 * server-streaming call (exactly one request message).
 *
 * @internal
 */
export async function* singleInput<T>(value: T): AsyncIterable<T> {
    yield value;
}
