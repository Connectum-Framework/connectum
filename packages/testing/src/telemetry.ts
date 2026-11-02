/**
 * Isolated OpenTelemetry for one test scenario.
 *
 * Collecting the spans and metrics of `@connectum/otel` instrumentation takes
 * more than registering a collector's provider with the OpenTelemetry API:
 * `@connectum/otel` keeps the tracer and meter it created for the provider that
 * was registered when it first recorded something, so every later scenario in
 * the same process would stay empty (and a parity comparison of two empty
 * results still passes). {@link withTelemetry} and the `telemetry` option of
 * `transportParityTest` do the whole sequence, in the right order, and undo it
 * when the scenario ends, whether it returned or threw.
 *
 * @module telemetry
 */

import { metrics as metricsApi, trace } from "@opentelemetry/api";
import { InMemoryMetricCollector, InMemorySpanCollector } from "./otel-collectors.ts";

/**
 * How a scenario gets telemetry of its own.
 */
export interface TelemetryOptions {
    /**
     * `shutdownProvider` from `@connectum/otel`. It is passed in rather than
     * imported so that `@connectum/testing` does not depend on
     * `@connectum/otel`, and so that the function that is reset is the one the
     * code under test uses.
     */
    shutdownProvider: () => Promise<void>;
}

/**
 * The collectors a scenario reads its telemetry from.
 */
export interface Telemetry {
    /** Receives every span the code under test records during the scenario. */
    spans: InMemorySpanCollector;
    /** Receives every metric the code under test records during the scenario. */
    metrics: InMemoryMetricCollector;
}

/**
 * Throws `TypeError` unless `telemetry` carries a `shutdownProvider` function.
 * The check runs when the test is declared, so a misspelled option fails at
 * once and not as an empty comparison later.
 */
export function validateTelemetryOptions(telemetry: unknown): asserts telemetry is TelemetryOptions {
    const shutdownProvider = (telemetry as { shutdownProvider?: unknown } | null | undefined)?.shutdownProvider;
    if (typeof shutdownProvider !== "function") {
        throw new TypeError(`telemetry.shutdownProvider must be a function (pass shutdownProvider from @connectum/otel), got ${typeof shutdownProvider}`);
    }
}

/**
 * Make `collectors` the process-wide OpenTelemetry providers and return the
 * function that undoes it.
 *
 * Order matters: the `@connectum/otel` provider is reset first, because its
 * cached tracer and meter belong to whichever provider was registered before;
 * the API's own registrations are cleared next, because it refuses to replace
 * a provider that is already registered.
 *
 * The undo clears the registrations and resets the `@connectum/otel` provider
 * once more, so nothing keeps a reference to collectors that are about to be
 * disposed. It does not dispose the collectors.
 */
export async function installTelemetry(collectors: Telemetry, options: TelemetryOptions): Promise<() => Promise<void>> {
    // The registrations are process-wide, so two scenarios cannot each own
    // them at once: the second would take them from the first, which would
    // then record into the wrong collector and, on cleanup, unregister the
    // second's. Refuse loudly instead of returning mixed or empty results.
    if (installed) {
        throw new Error("telemetry: another scenario already holds the OpenTelemetry providers; run scenarios that use telemetry one after another, not concurrently");
    }
    installed = true;
    try {
        await options.shutdownProvider();
    } catch (error) {
        installed = false;
        throw error;
    }
    trace.disable();
    metricsApi.disable();
    const tracerRegistered = trace.setGlobalTracerProvider(collectors.spans.provider);
    const meterRegistered = metricsApi.setGlobalMeterProvider(collectors.metrics.provider);
    if (!tracerRegistered || !meterRegistered) {
        trace.disable();
        metricsApi.disable();
        installed = false;
        throw new Error("telemetry: the OpenTelemetry API refused the collectors' providers; another provider is registered and could not be cleared");
    }
    return async () => {
        try {
            trace.disable();
            metricsApi.disable();
            await options.shutdownProvider();
        } finally {
            installed = false;
        }
    };
}

/** Whether a scenario currently holds the process-wide registrations. */
let installed = false;

/**
 * Run `body` with a fresh span collector and a fresh metric collector
 * registered as the OpenTelemetry providers, then restore a clean state.
 * Any number of scenarios may follow one another in one process and each sees
 * only its own telemetry.
 *
 * The requirement that `OTEL_TRACES_EXPORTER` and `OTEL_METRICS_EXPORTER` be
 * `none` while the scenario runs stays with the caller: with another exporter
 * `@connectum/otel` records into providers of its own, never into the
 * registered ones. Context propagation across a client and a server span needs
 * a context manager registered by the caller as well.
 *
 * @example
 * ```typescript
 * import { shutdownProvider } from "@connectum/otel";
 * import { withTelemetry } from "@connectum/testing";
 *
 * const names = await withTelemetry({ shutdownProvider }, async ({ spans }) => {
 *     await client.sayHello({ name: "world" });
 *     return spans.flush().map((s) => s.name);
 * });
 * ```
 *
 * @param options - The `shutdownProvider` of `@connectum/otel`
 * @param body - The scenario; receives the collectors
 * @returns What `body` returned
 * @throws TypeError when `options.shutdownProvider` is not a function
 */
export async function withTelemetry<T>(options: TelemetryOptions, body: (telemetry: Telemetry) => Promise<T>): Promise<T> {
    validateTelemetryOptions(options);
    const telemetry: Telemetry = { spans: new InMemorySpanCollector(), metrics: new InMemoryMetricCollector() };
    let uninstall: (() => Promise<void>) | undefined;
    try {
        uninstall = await installTelemetry(telemetry, options);
        return await body(telemetry);
    } finally {
        try {
            await uninstall?.();
        } finally {
            await telemetry.spans.dispose();
            await telemetry.metrics.dispose();
        }
    }
}
