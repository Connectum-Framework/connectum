/**
 * Portable mock function factory.
 *
 * Provides a lightweight spy that is API-compatible with `node:test`
 * `mock.fn()` (`.mock.calls`, `.mock.callCount()`) but does **not**
 * depend on `node:test`, making it safe for Node.js, Bun, Deno,
 * and bundler environments.
 *
 * @module
 */

/**
 * A single recorded invocation of a {@link MockFn}.
 */
export interface MockCall<Args extends readonly unknown[] = readonly unknown[]> {
    /** The arguments passed to the mock function. */
    readonly arguments: Args;
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
        /** Ordered list of recorded calls. */
        readonly calls: ReadonlyArray<MockCall<Parameters<F>>>;
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
    const calls: Array<MockCall<Parameters<F>>> = [];

    const fn = ((...args: Parameters<F>) => {
        calls.push({ arguments: args });
        return impl(...args);
    }) as MockFn<F>;

    Object.defineProperty(fn, "mock", {
        value: {
            calls,
            callCount: () => calls.length,
        },
        writable: false,
    });

    return fn;
}
