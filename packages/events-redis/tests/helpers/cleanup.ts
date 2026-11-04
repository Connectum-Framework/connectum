/**
 * Run `body`, then every cleanup step, whatever happens.
 *
 * A failing step never stops the steps after it (a rejected `disconnect()` must not leave a control
 * client, a proxy or its sockets open). When `body` failed, its error is the one that propagates and
 * cleanup failures are dropped; when `body` succeeded, cleanup failures surface as an `AggregateError`.
 */
export async function withCleanup<T>(body: () => Promise<T>, steps: ReadonlyArray<() => unknown>): Promise<T> {
    let result: T;
    try {
        result = await body();
    } catch (error) {
        await runSteps(steps).catch(() => undefined);
        throw error;
    }
    await runSteps(steps);
    return result;
}

async function runSteps(steps: ReadonlyArray<() => unknown>): Promise<void> {
    const errors: unknown[] = [];
    for (const step of steps) {
        try {
            await step();
        } catch (error) {
            errors.push(error);
        }
    }
    if (errors.length > 0) {
        throw new AggregateError(errors, "test cleanup failed");
    }
}
