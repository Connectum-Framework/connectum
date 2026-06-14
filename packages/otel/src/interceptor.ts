/**
 * ConnectRPC OpenTelemetry interceptor
 *
 * Creates a ConnectRPC interceptor that instruments RPC calls with
 * OpenTelemetry tracing and metrics following semantic conventions.
 *
 * @see https://opentelemetry.io/docs/specs/semconv/rpc/connect-rpc/
 * @see https://opentelemetry.io/docs/specs/semconv/rpc/rpc-metrics/
 * @module interceptor
 */

import { hostname } from "node:os";
import type { Interceptor } from "@connectrpc/connect";
import type { Link, SpanOptions } from "@opentelemetry/api";
import { context, propagation, SpanKind, SpanStatusCode, trace } from "@opentelemetry/api";

import { ATTR_CONNECTUM_TRANSPORT, ATTR_CONNECTUM_TRANSPORT_METRIC } from "./attributes.ts";
import { getMeter } from "./meter.ts";
import type { RpcServerMetrics } from "./metrics.ts";
import { createRpcServerMetrics } from "./metrics.ts";
import { applyAttributeFilter, buildBaseAttributes, buildErrorAttributes, detectConnectumTransport, estimateMessageSize, wrapAsyncIterable } from "./shared.ts";
import { getTracer } from "./tracer.ts";
import type { OtelInterceptorOptions } from "./types.ts";

/**
 * Creates a ConnectRPC interceptor that instruments RPC calls with
 * OpenTelemetry tracing and/or metrics.
 *
 * The interceptor follows OpenTelemetry semantic conventions for RPC:
 * - Creates server spans with standard RPC attributes
 * - Records call duration, request size, and response size metrics
 * - Supports context propagation with configurable trust mode
 * - Handles both unary and streaming calls
 *
 * @param options - Configuration options for the interceptor
 * @returns A ConnectRPC Interceptor function
 *
 * @example
 * ```typescript
 * import { createOtelInterceptor } from '@connectum/otel';
 * import { createServer } from '@connectum/core';
 *
 * const server = createServer({
 *     services: [routes],
 *     interceptors: [createOtelInterceptor({
 *         serverPort: 5000,
 *         filter: ({ service }) => !service.includes("Health"),
 *     })],
 * });
 * ```
 */
export function createOtelInterceptor(options: OtelInterceptorOptions = {}): Interceptor {
    const {
        withoutTracing = false,
        withoutMetrics = false,
        trustRemote = false,
        filter,
        attributeFilter,
        serverAddress = hostname(),
        serverPort,
        recordMessages = false,
    } = options;

    let rpcMetrics: RpcServerMetrics | undefined;

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

        // Tag with originating transport (in-process router-transport vs HTTP/2).
        // The marker is set by `createLocalTransport` from `@connectum/core`.
        // The span attribute uses the dotted form (`connectum.transport`) per
        // OTel attribute conventions; the metric label uses the short form
        // (`transport`) per OTel metric-label conventions. They are kept
        // separate so the metric-side label set does not accidentally pick
        // up the span-side attribute (which would make the parity diff
        // observe two transport labels on the same metric).
        const transportKind = detectConnectumTransport(req.header);

        // Apply attribute filter if provided. The `connectum.transport`
        // attribute is added *after* filtering so user attribute filters
        // cannot accidentally strip it.
        const filteredAttributes: Record<string, unknown> = { ...applyAttributeFilter(baseAttributes, attributeFilter) };
        const spanAttributes = { ...filteredAttributes, [ATTR_CONNECTUM_TRANSPORT]: transportKind };

        // Metric label uses the short key per OTel metric-label conventions.
        const metricTransportAttrs = { [ATTR_CONNECTUM_TRANSPORT_METRIC]: transportKind };

        // 4. Context propagation: extract trace context from request headers
        const headers = Object.fromEntries(req.header.entries());
        const extractedContext = propagation.extract(context.active(), headers);
        const parentContext = trustRemote ? extractedContext : context.active();

        // 5. Start timing
        const startTime = performance.now();

        // 6. Estimate request size (only for unary calls)
        const requestSize = !req.stream ? estimateMessageSize(req.message) : 0;

        // 7. Span name per OTel RPC convention: "package.ServiceName/MethodName"
        const spanName = `${req.service.typeName}/${req.method.name}`;

        // Helper to record metrics with lazy initialization
        const recordMetrics = (duration: number, responseSize: number, errorAttrs?: Record<string, string | number>) => {
            if (withoutMetrics) return;
            if (!rpcMetrics) {
                rpcMetrics = createRpcServerMetrics(getMeter());
            }
            const metricAttrs = { ...filteredAttributes, ...metricTransportAttrs, ...errorAttrs };
            rpcMetrics.callDuration.record(duration, metricAttrs);
            rpcMetrics.requestSize.record(requestSize, metricAttrs);
            rpcMetrics.responseSize.record(responseSize, metricAttrs);
        };

        // 8. Metrics-only mode (tracing disabled)
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

        // 9. Full instrumentation: tracing + optional metrics
        const tracer = getTracer();

        // Build span options with server kind and base attributes.
        // Uses `spanAttributes` (includes `connectum.transport`); the metric
        // path uses the bare `filteredAttributes` plus `metricTransportAttrs`.
        const spanOptions: SpanOptions = {
            kind: SpanKind.SERVER,
            attributes: spanAttributes,
        };

        // When not trusting remote context, create a root span with a link
        // to the remote span instead of using it as parent
        if (!trustRemote) {
            const remoteSpanContext = trace.getSpanContext(extractedContext);
            if (remoteSpanContext) {
                const link: Link = { context: remoteSpanContext };
                spanOptions.links = [link];
            }
        }

        return tracer.startActiveSpan(spanName, spanOptions, parentContext, async (span) => {
            try {
                // Wrap streaming request messages for instrumentation
                const instrumentedReq = req.stream
                    ? Object.assign(Object.create(Object.getPrototypeOf(req)), req, {
                          message: wrapAsyncIterable(req.message as AsyncIterable<unknown>, span, "RECEIVED", recordMessages),
                      })
                    : req;

                if (!req.stream && recordMessages) {
                    span.addEvent("rpc.message", {
                        "rpc.message.type": "RECEIVED",
                        "rpc.message.id": 1,
                        "rpc.message.uncompressed_size": requestSize,
                    });
                }

                const response = await next(instrumentedReq);

                const duration = (performance.now() - startTime) / 1000;

                // Wrap streaming response messages for instrumentation
                if (response.stream) {
                    const wrappedResponse = Object.assign(Object.create(Object.getPrototypeOf(response)), response, {
                        message: wrapAsyncIterable(response.message as AsyncIterable<unknown>, span, "SENT", recordMessages, true),
                    });
                    recordMetrics(duration, 0);
                    return wrappedResponse;
                }

                const responseSize = estimateMessageSize(response.message);

                if (recordMessages) {
                    span.addEvent("rpc.message", {
                        "rpc.message.type": "SENT",
                        "rpc.message.id": 1,
                        "rpc.message.uncompressed_size": responseSize,
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
