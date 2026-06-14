/**
 * Header propagation for `ctx.call` / `ctx.stream`.
 *
 * By default Connectum propagates NO inbound headers to outgoing catalog calls
 * (no hidden behaviour). Opt in by listing header names in
 * `createServer({ propagateHeaders })`; explicit `CallOptions.headers` always
 * take precedence over propagated values.
 *
 * {@link defaultPropagateHeaders} is a ready-made set you can spread and tweak,
 * mirroring the opt-in `createDefaultInterceptors` ergonomics:
 *
 * ```ts
 * createServer({ propagateHeaders: [...defaultPropagateHeaders, "x-tenant-id"] });
 * ```
 *
 * @module propagateHeaders
 */

/**
 * Recommended default allow-list: W3C trace-context headers only.
 *
 * Trace headers let a downstream call continue the inbound trace even without
 * an OpenTelemetry SDK. When the `@connectum/otel` client interceptor is also
 * mounted in `outgoingInterceptors`, it overwrites `traceparent` with the
 * active span's context (so the OTel value wins — no conflicting double value).
 *
 * `authorization` is intentionally excluded: forwarding credentials is a
 * deliberate, security-sensitive choice the caller must opt into explicitly.
 */
export const defaultPropagateHeaders: readonly string[] = ["traceparent", "tracestate"];
