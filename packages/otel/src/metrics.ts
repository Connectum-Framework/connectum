/**
 * RPC Metrics for OpenTelemetry
 *
 * Provides pre-configured histograms for measuring RPC server and client performance
 * based on OpenTelemetry semantic conventions for RPC metrics.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/rpc/rpc-metrics/
 * @module metrics
 */

import type { Histogram, Meter } from "@opentelemetry/api";

/**
 * Explicit bucket boundaries (seconds) for the RPC call-duration histograms
 *
 * The SDK default boundaries are a millisecond scale (`0, 5, 10, 25, ... 10000`), so every
 * RPC duration recorded in seconds would land in the first bucket and percentiles
 * would be unusable. These are the values the OpenTelemetry RPC metrics specification
 * recommends for `rpc.{server,client}.call.duration`. An application `View` still overrides them.
 */
export const RPC_DURATION_BUCKETS: readonly number[] = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10];

/**
 * Pre-configured RPC server metric instruments
 *
 * Contains histograms for call duration, request size, and response size
 * following OpenTelemetry RPC semantic conventions.
 */
export interface RpcServerMetrics {
    /** Histogram measuring duration of RPC server calls (unit: seconds) */
    callDuration: Histogram;
    /** Histogram measuring size of RPC server request messages (unit: bytes) */
    requestSize: Histogram;
    /** Histogram measuring size of RPC server response messages (unit: bytes) */
    responseSize: Histogram;
}

/**
 * Pre-configured RPC client metric instruments
 *
 * Contains histograms for call duration, request size, and response size
 * following OpenTelemetry RPC semantic conventions.
 */
export interface RpcClientMetrics {
    /** Histogram measuring duration of RPC client calls (unit: seconds) */
    callDuration: Histogram;
    /** Histogram measuring size of RPC client request messages (unit: bytes) */
    requestSize: Histogram;
    /** Histogram measuring size of RPC client response messages (unit: bytes) */
    responseSize: Histogram;
}

/**
 * Creates RPC server metric instruments from the given meter
 *
 * All metrics follow OpenTelemetry semantic conventions for RPC:
 * - `rpc.server.call.duration` -- call duration in seconds
 * - `rpc.server.request.size` -- request message size in bytes
 * - `rpc.server.response.size` -- response message size in bytes
 *
 * @param meter - OpenTelemetry Meter instance to create histograms from
 * @returns Object containing all RPC server metric instruments
 *
 * @example
 * ```typescript
 * import { metrics } from '@opentelemetry/api';
 * import { createRpcServerMetrics } from '@connectum/otel';
 *
 * const meter = metrics.getMeter('my-service');
 * const rpcMetrics = createRpcServerMetrics(meter);
 *
 * rpcMetrics.callDuration.record(0.123, { 'rpc.method': 'GetUser' });
 * ```
 */
export function createRpcServerMetrics(meter: Meter): RpcServerMetrics {
    const callDuration = meter.createHistogram("rpc.server.call.duration", {
        description: "Duration of RPC server calls",
        unit: "s",
        advice: { explicitBucketBoundaries: [...RPC_DURATION_BUCKETS] },
    });

    const requestSize = meter.createHistogram("rpc.server.request.size", {
        description: "Size of RPC server request messages",
        unit: "By",
    });

    const responseSize = meter.createHistogram("rpc.server.response.size", {
        description: "Size of RPC server response messages",
        unit: "By",
    });

    return { callDuration, requestSize, responseSize };
}

/**
 * Creates RPC client metric instruments from the given meter
 *
 * All metrics follow OpenTelemetry semantic conventions for RPC:
 * - `rpc.client.call.duration` -- call duration in seconds
 * - `rpc.client.request.size` -- request message size in bytes
 * - `rpc.client.response.size` -- response message size in bytes
 *
 * @param meter - OpenTelemetry Meter instance to create histograms from
 * @returns Object containing all RPC client metric instruments
 *
 * @example
 * ```typescript
 * import { metrics } from '@opentelemetry/api';
 * import { createRpcClientMetrics } from '@connectum/otel';
 *
 * const meter = metrics.getMeter('my-client');
 * const rpcMetrics = createRpcClientMetrics(meter);
 *
 * rpcMetrics.callDuration.record(0.045, { 'rpc.method': 'GetUser' });
 * ```
 */
export function createRpcClientMetrics(meter: Meter): RpcClientMetrics {
    const callDuration = meter.createHistogram("rpc.client.call.duration", {
        description: "Duration of RPC client calls",
        unit: "s",
        advice: { explicitBucketBoundaries: [...RPC_DURATION_BUCKETS] },
    });

    const requestSize = meter.createHistogram("rpc.client.request.size", {
        description: "Size of RPC client request messages",
        unit: "By",
    });

    const responseSize = meter.createHistogram("rpc.client.response.size", {
        description: "Size of RPC client response messages",
        unit: "By",
    });

    return { callDuration, requestSize, responseSize };
}
