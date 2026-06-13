/**
 * Transport / streaming-kind validation
 *
 * The Connect protocol requires HTTP/2 for bidi-streaming RPCs ("Bidirectional
 * streaming requires HTTP/2, but the other RPC types also support HTTP/1.1" —
 * connectrpc.com/docs/protocol). HTTP/1.1 is half-duplex at the wire level, so
 * a bidi method registers cleanly and then fails silently at runtime: the
 * first client send hangs forever (or yields HTTP 505). This module turns that
 * misconfiguration into a startup-time diagnostic.
 *
 * Two transport situations are diagnosed:
 * - **plaintext HTTP/1.1** (no TLS, `allowHTTP1: true` — the default): bidi can
 *   only ever fail → `error` by default (configurable).
 * - **TLS with `allowHTTP1: true`**: the server negotiates HTTP/2 via ALPN, so
 *   bidi works for HTTP/2 clients — but a client (or proxy) that negotiates
 *   HTTP/1.1 over TLS hits the same hang. This is a residual risk, not a
 *   certain failure, so it is always a one-time `warn` (never a hard error):
 *   a mixed port serving HTTP/1.1 unary clients alongside HTTP/2 bidi clients
 *   is a legitimate, if discouraged, configuration. Setting `allowHTTP1: false`
 *   makes the server refuse HTTP/1.1 at ALPN and removes the risk entirely.
 *
 * Unary, server-streaming, and client-streaming are excluded: the Connect
 * protocol supports them over HTTP/1.1.
 *
 * @module TransportValidation
 */

import type { DescFile } from "@bufbuild/protobuf";

/**
 * Stable error code for the streaming-vs-transport startup diagnostic.
 * Searchable in logs and docs.
 */
export const TRANSPORT_VALIDATION_ERROR_CODE = "CONNECTUM_UNSUPPORTED_STREAMING_TRANSPORT";

/** Validation severity. */
export const TransportValidationMode = {
    ERROR: "error",
    WARN: "warn",
    OFF: "off",
} as const;

export type TransportValidationMode = (typeof TransportValidationMode)[keyof typeof TransportValidationMode];

/**
 * Effective transport resolved from `tls` + `allowHTTP1`.
 *
 * - `plaintext-h1` — no TLS, `allowHTTP1: true` (default): HTTP/1.1 only.
 * - `h2c` — no TLS, `allowHTTP1: false`: plaintext HTTP/2.
 * - `tls-h1-negotiable` — TLS, `allowHTTP1: true`: ALPN offers both; a client
 *   may negotiate HTTP/1.1 (residual bidi risk).
 * - `tls-h2-only` — TLS, `allowHTTP1: false`: ALPN refuses HTTP/1.1.
 */
export const EffectiveTransport = {
    PLAINTEXT_H1: "plaintext-h1",
    H2C: "h2c",
    TLS_H1_NEGOTIABLE: "tls-h1-negotiable",
    TLS_H2_ONLY: "tls-h2-only",
} as const;

export type EffectiveTransport = (typeof EffectiveTransport)[keyof typeof EffectiveTransport];

/**
 * Resolve the effective transport from the server's TLS and `allowHTTP1`
 * configuration. `allowHTTP1` defaults to `true` (matching TransportManager).
 */
export function resolveEffectiveTransport(options: { hasTls: boolean; allowHTTP1?: boolean | undefined }): EffectiveTransport {
    const allowHTTP1 = options.allowHTTP1 ?? true;
    if (options.hasTls) {
        return allowHTTP1 ? EffectiveTransport.TLS_H1_NEGOTIABLE : EffectiveTransport.TLS_H2_ONLY;
    }
    return allowHTTP1 ? EffectiveTransport.PLAINTEXT_H1 : EffectiveTransport.H2C;
}

/** A streaming method that requires HTTP/2. */
export interface StreamingMethodInfo {
    /** Fully qualified service typeName (e.g. `acme.v1.ScannerService`). */
    readonly service: string;
    /** Method name (e.g. `StreamCodes`). */
    readonly method: string;
    /** Streaming kind: `bidi_streaming`. */
    readonly kind: string;
}

/**
 * Startup validation error: bidi-streaming methods registered on a
 * transport that cannot carry them. Carries the stable
 * {@link TRANSPORT_VALIDATION_ERROR_CODE} code and the affected methods.
 */
export class TransportValidationError extends Error {
    readonly code = TRANSPORT_VALIDATION_ERROR_CODE;
    readonly methods: readonly StreamingMethodInfo[];

    constructor(message: string, methods: readonly StreamingMethodInfo[]) {
        super(message);
        this.name = "TransportValidationError";
        this.methods = methods;
    }
}

/**
 * Collect bidi-streaming methods from a DescFile registry (built during
 * route registration). Client-streaming is NOT collected — the Connect
 * protocol supports it over HTTP/1.1.
 */
export function collectStreamingMethods(registry: readonly DescFile[]): StreamingMethodInfo[] {
    const result: StreamingMethodInfo[] = [];
    for (const file of registry) {
        for (const service of file.services) {
            for (const method of service.methods) {
                if (method.methodKind === "bidi_streaming") {
                    result.push({ service: service.typeName, method: method.name, kind: method.methodKind });
                }
            }
        }
    }
    return result;
}

/** Format the affected-methods list. */
function formatMethodList(methods: readonly StreamingMethodInfo[]): string {
    return methods.map((m) => `  - ${m.service}.${m.method} (${m.kind})`).join("\n");
}

/**
 * Diagnostic for the **plaintext HTTP/1.1** case: bidi can never work here.
 * Names the methods, the effective transport, both remediations, and the
 * runtime symptoms («first send hangs», «HTTP 505») for log searchability.
 */
export function formatTransportValidationMessage(methods: readonly StreamingMethodInfo[]): string {
    return (
        `[${TRANSPORT_VALIDATION_ERROR_CODE}] The following bidi-streaming methods require HTTP/2, ` +
        `but the effective transport is plaintext HTTP/1.1 (no TLS, allowHTTP1: true — the default):\n` +
        `${formatMethodList(methods)}\n` +
        `Without HTTP/2 these calls fail silently at runtime: the first send hangs forever ` +
        `(or the client receives HTTP 505).\n` +
        `Fix one of:\n` +
        `  1. allowHTTP1: false — plaintext h2c (recommended for internal services);\n` +
        `  2. configure TLS — HTTP/2 via ALPN.\n` +
        `Or downgrade this check: transportValidation: "warn" | "off".`
    );
}

/**
 * Diagnostic for the **TLS + allowHTTP1** case: bidi works for HTTP/2 clients,
 * but a client that negotiates HTTP/1.1 over TLS hits the same hang. Residual
 * risk → warning only.
 */
export function formatTlsHttp1WarningMessage(methods: readonly StreamingMethodInfo[]): string {
    return (
        `[${TRANSPORT_VALIDATION_ERROR_CODE}] The TLS server allows HTTP/1.1 (allowHTTP1: true), so ALPN may ` +
        `negotiate HTTP/1.1 with some clients or proxies. The following bidi-streaming methods require HTTP/2 ` +
        `and will hang for any client that negotiates HTTP/1.1:\n` +
        `${formatMethodList(methods)}\n` +
        `If you do not need to serve HTTP/1.1 clients, set allowHTTP1: false so the server refuses HTTP/1.1 at ` +
        `ALPN (HTTP/1.1 clients then fail the TLS handshake explicitly instead of hanging on bidi).\n` +
        `Silence this warning with transportValidation: "off".`
    );
}

/**
 * Validate bidi-streaming methods against the effective transport.
 *
 * @returns A {@link TransportValidationError} to throw (plaintext HTTP/1.1 +
 * `mode: "error"`), or `null` after optionally logging a one-time warning
 * (plaintext HTTP/1.1 + `mode: "warn"`, or TLS-with-HTTP/1.1 in any non-`off`
 * mode) / doing nothing (`mode: "off"`, an HTTP/2-only transport, or no bidi
 * methods).
 */
export function validateTransport(options: { registry: readonly DescFile[]; transport: EffectiveTransport; mode: TransportValidationMode }): TransportValidationError | null {
    if (options.mode === TransportValidationMode.OFF) {
        return null;
    }
    // HTTP/2-only transports (h2c, TLS without HTTP/1.1) carry bidi fine.
    if (options.transport === EffectiveTransport.H2C || options.transport === EffectiveTransport.TLS_H2_ONLY) {
        return null;
    }

    const methods = collectStreamingMethods(options.registry);
    if (methods.length === 0) {
        return null;
    }

    // TLS that also negotiates HTTP/1.1: residual risk only — always a
    // one-time warning, never a hard error (mixed h1-unary + h2-bidi on one
    // port is a legitimate, if discouraged, configuration).
    if (options.transport === EffectiveTransport.TLS_H1_NEGOTIABLE) {
        console.warn(formatTlsHttp1WarningMessage(methods));
        return null;
    }

    // Plaintext HTTP/1.1: bidi can never work.
    const message = formatTransportValidationMessage(methods);
    if (options.mode === TransportValidationMode.WARN) {
        console.warn(message);
        return null;
    }
    return new TransportValidationError(message, methods);
}
