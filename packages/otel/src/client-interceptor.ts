/**
 * ConnectRPC OpenTelemetry client interceptor
 *
 * Creates a ConnectRPC interceptor that instruments outgoing RPC calls with
 * OpenTelemetry tracing and metrics following semantic conventions.
 *
 * Key differences from the server interceptor:
 * - Uses `propagation.inject()` to propagate trace context to outgoing requests
 * - Uses `SpanKind.CLIENT` instead of `SpanKind.SERVER`
 * - Uses `rpc.client.*` metrics instead of `rpc.server.*`
 * - `serverAddress` is REQUIRED (target server, not local hostname)
 * - No `trustRemote` option (client always creates spans in active context)
 *
 * @see https://opentelemetry.io/docs/specs/semconv/rpc/connect-rpc/
 * @see https://opentelemetry.io/docs/specs/semconv/rpc/rpc-metrics/
 * @module client-interceptor
 */

import type { Interceptor } from "@connectrpc/connect";
import type { SpanOptions } from "@opentelemetry/api";
import { SpanKind, SpanStatusCode, context, propagation } from "@opentelemetry/api";

import { getMeter } from "./meter.ts";
import type { RpcClientMetrics } from "./metrics.ts";
import { createRpcClientMetrics } from "./metrics.ts";
import { applyAttributeFilter, buildBaseAttributes, buildErrorAttributes, estimateMessageSize } from "./shared.ts";
import { getTracer } from "./tracer.ts";
import type { OtelClientInterceptorOptions } from "./types.ts";

/**
 * Creates a ConnectRPC interceptor that instruments outgoing RPC calls with
 * OpenTelemetry tracing and/or metrics.
 *
 * The interceptor follows OpenTelemetry semantic conventions for RPC:
 * - Creates client spans with standard RPC attributes
 * - Injects trace context into outgoing request headers for propagation
 * - Records call duration, request size, and response size metrics
 * - Handles both unary and streaming calls
 *
 * @param options - Configuration options for the client interceptor
 * @returns A ConnectRPC Interceptor function
 *
 * @example
 * ```typescript
 * import { createOtelClientInterceptor } from '@connectum/otel';
 * import { createConnectTransport } from '@connectrpc/connect-node';
 *
 * const transport = createConnectTransport({
 *     baseUrl: 'http://localhost:5000',
 *     interceptors: [createOtelClientInterceptor({
 *         serverAddress: 'localhost',
 *         serverPort: 5000,
 *         filter: ({ service }) => !service.includes("Health"),
 *     })],
 * });
 * ```
 */
export function createOtelClientInterceptor(options: OtelClientInterceptorOptions): Interceptor {
    const { withoutTracing = false, withoutMetrics = false, filter, attributeFilter, serverAddress, serverPort, recordMessages = false } = options;

    let rpcMetrics: RpcClientMetrics | undefined;

    return (next) => async (req) => {
        // 1. Filter check: skip instrumentation if filter returns false
        if (filter) {
            const shouldInstrument = filter({
                service: req.service.typeName,
                method: req.method.name,
                stream: req.stream,
            });
            if (!shouldInstrument) return next(req);
        }

        // 2. No-op check: if both tracing and metrics are disabled, pass through
        if (withoutTracing && withoutMetrics) return next(req);

        // 3. Build base attributes per OTel RPC semantic conventions
        const baseAttributes = buildBaseAttributes({
            service: req.service.typeName,
            method: req.method.name,
            serverAddress,
            serverPort,
        });

        // Apply attribute filter if provided
        const filteredAttributes = applyAttributeFilter(baseAttributes, attributeFilter);

        // 4. Start timing
        const startTime = performance.now();

        // 5. Estimate request size (only for unary calls)
        const requestSize = !req.stream ? estimateMessageSize(req.message) : 0;

        // 6. Span name per OTel RPC convention: "package.ServiceName/MethodName"
        const spanName = `${req.service.typeName}/${req.method.name}`;

        // Helper to record metrics with lazy initialization
        const recordMetrics = (duration: number, responseSize: number, errorAttrs?: Record<string, string | number>) => {
            if (withoutMetrics) return;
            if (!rpcMetrics) {
                rpcMetrics = createRpcClientMetrics(getMeter());
            }
            const metricAttrs = { ...filteredAttributes, ...errorAttrs };
            rpcMetrics.callDuration.record(duration, metricAttrs);
            rpcMetrics.requestSize.record(requestSize, metricAttrs);
            rpcMetrics.responseSize.record(responseSize, metricAttrs);
        };

        // 7. Metrics-only mode (tracing disabled)
        if (withoutTracing) {
            try {
                const response = await next(req);
                const duration = (performance.now() - startTime) / 1000;
                const responseSize = !response.stream ? estimateMessageSize(response.message) : 0;
                recordMetrics(duration, responseSize);
                return response;
            } catch (error) {
                const duration = (performance.now() - startTime) / 1000;
                const errorAttrs = buildErrorAttributes(error);
                recordMetrics(duration, 0, errorAttrs);
                throw error;
            }
        }

        // 8. Full instrumentation: tracing + optional metrics
        const tracer = getTracer();

        // Build span options with client kind and base attributes
        const spanOptions: SpanOptions = {
            kind: SpanKind.CLIENT,
            attributes: filteredAttributes,
        };

        return tracer.startActiveSpan(spanName, spanOptions, context.active(), async (span) => {
            try {
                // Inject trace context into outgoing request headers
                propagation.inject(context.active(), req.header, {
                    set(carrier, key, value) {
                        carrier.set(key, value);
                    },
                });

                // Record request message event if enabled
                if (recordMessages && !req.stream) {
                    span.addEvent("message", {
                        "message.type": "SENT",
                        "message.uncompressed_size": requestSize,
                    });
                }

                const response = await next(req);

                const duration = (performance.now() - startTime) / 1000;
                const responseSize = !response.stream ? estimateMessageSize(response.message) : 0;

                // Record response message event if enabled
                if (recordMessages && !response.stream) {
                    span.addEvent("message", {
                        "message.type": "RECEIVED",
                        "message.uncompressed_size": responseSize,
                    });
                }

                span.setStatus({ code: SpanStatusCode.OK });
                span.end();

                recordMetrics(duration, responseSize);

                return response;
            } catch (error) {
                const duration = (performance.now() - startTime) / 1000;
                const errorAttrs = buildErrorAttributes(error);

                span.recordException(error as Error);
                span.setStatus({ code: SpanStatusCode.ERROR, message: (error as Error).message });

                // Set error attributes on span
                for (const [key, value] of Object.entries(errorAttrs)) {
                    span.setAttribute(key, value);
                }

                span.end();

                recordMetrics(duration, 0, errorAttrs);

                throw error;
            }
        });
    };
}
