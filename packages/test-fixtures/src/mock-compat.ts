/**
 * Portable mock function factory.
 *
 * Provides a lightweight spy that is API-compatible with `node:test`
 * `mock.fn()` (`.mock.calls` with `arguments`, `result`, `error` and `this` of each
 * call, `.mock.callCount()`) but does **not**
 * depend on `node:test`, making it safe for Node.js, Bun, Deno,
 * and bundler environments.
 *
 * Not recorded, unlike `node:test`: the `stack` and `target` of a call, and the other
 * `mock.fn()` members (`mockImplementation()`, `resetCalls()`, `restore()` and so on).
 *
 * @module
 */

/**
 * A single recorded invocation of a {@link MockFn}.
 */
export interface MockCall<Args extends readonly unknown[] = readonly unknown[], Result = unknown> {
    /** The arguments passed to the mock function. */
    readonly arguments: Args;
    /**
     * What the implementation returned; `undefined` when it threw. For an async
     * implementation this is the promise, and a rejection is not recorded as `error`
     * (the same as `node:test`).
     */
    readonly result: Result | undefined;
    /** What the implementation threw; `undefined` when it returned. */
    readonly error: unknown;
    /** The `this` the mock function was called with. */
    readonly this: unknown;
}

/**
 * A callable spy that records every invocation.
 *
 * The shape intentionally mirrors the subset of `node:test` `mock.fn()`
 * that Connectum testing utilities rely on.
 */
// biome-ignore lint/suspicious/noExplicitAny: generic function constraint requires any for Parameters<F>/ReturnType<F> inference
export interface MockFn<F extends (...args: any[]) => any> {
    (...args: Parameters<F>): ReturnType<F>;
    /** Spy metadata. */
    readonly mock: {
        /** Ordered list of recorded calls: a fresh copy on every read, as in `node:test`. */
        readonly calls: ReadonlyArray<MockCall<Parameters<F>, ReturnType<F>>>;
        /** Returns the total number of recorded calls. */
        callCount(): number;
    };
}

/**
 * Create a portable mock function that wraps `impl` and records every call.
 *
 * @param impl - The underlying implementation to delegate to.
 * @returns A spy-enabled wrapper whose `.mock` property exposes call metadata.
 *
 * @example
 * ```ts
 * const add = createMockFn((a: number, b: number) => a + b);
 * add(1, 2);
 * add(3, 4);
 * add.mock.callCount(); // 2
 * add.mock.calls[0].arguments; // [1, 2]
 * ```
 */
// biome-ignore lint/suspicious/noExplicitAny: generic function constraint requires any for Parameters<F>/ReturnType<F> inference
export function createMockFn<F extends (...args: any[]) => any>(impl: F): MockFn<F> {
    const calls: Array<MockCall<Parameters<F>, ReturnType<F>>> = [];

    // A regular function, not an arrow: the receiver of a call has to reach the implementation.
    const fn = function (this: unknown, ...args: Parameters<F>): ReturnType<F> {
        const call: { arguments: Parameters<F>; result: ReturnType<F> | undefined; error: unknown; this: unknown } = {
            arguments: args,
            result: undefined,
            error: undefined,
            this: this,
        };
        // Recorded before the implementation runs, so a call that throws is still counted.
        calls.push(call);
        try {
            call.result = Reflect.apply(impl, this, args);
        } catch (error) {
            call.error = error;
            throw error;
        }
        return call.result as ReturnType<F>;
    } as MockFn<F>;

    Object.defineProperty(fn, "mock", {
        value: {
            // A copy, as in node:test: a list taken earlier does not grow with later calls and
            // clearing it does not reset callCount().
            get calls() {
                return calls.slice();
            },
            callCount: () => calls.length,
        },
        writable: false,
    });

    return fn;
}
