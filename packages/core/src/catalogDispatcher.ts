/**
 * Catalog dispatcher — the per-request engine behind `ctx.call`.
 *
 * One `CatalogDispatcher` exists per `Server`. It owns the seam that turns the
 * raw ConnectRPC `HandlerContext` into a Connectum {@link Context} (adding the
 * typed `call` primitive) and routes each `ctx.call` to the in-process
 * transport (local services) or the resolver-supplied transport (remote
 * services), applying the signal/deadline cascade.
 *
 * Error model (Q15 split): configuration mistakes surface as
 * {@link CatalogConfigError} at construction/startup (handled in `Server`);
 * everything reachable from a live `ctx.call` is operational and surfaces as a
 * `ConnectError` with a meaningful `Code`.
 *
 * @module catalogDispatcher
 */

import type { DescMessage, DescMethod, DescMethodStreaming, DescMethodUnary, DescService, MessageInitShape } from "@bufbuild/protobuf";
import type { HandlerContext, ServiceImpl, Transport } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import type { BidiStreamHandle, CallOptions, ClientStreamHandle, ConnectumServiceImpl, Context } from "./context.ts";
import type { ServiceCatalog } from "./serviceCatalog.ts";
import { createInputQueue, singleInput } from "./streamBridge.ts";

/**
 * The server-side surface the dispatcher reads at call time. Implemented by
 * `ServerImpl`; declared here so the dispatcher stays decoupled from `Server`.
 *
 * @internal
 */
export interface CatalogDispatchHost {
    /** The configured service catalog, or `undefined` when none is set. */
    readonly catalog: ServiceCatalog | undefined;
    /** Inbound header names copied onto outgoing catalog calls (empty by default). */
    readonly propagateHeaders: readonly string[];
    /** Whether `typeName` is mounted locally on this server. */
    isLocal(typeName: string): boolean;
    /** The in-process transport carrying `outgoingInterceptors` (lazily built). */
    getLocalTransport(): Transport;
    /** Resolve (and cache) a remote transport, or `null` when unroutable. May throw. */
    resolveRemoteTransport(typeName: string, endpoint?: string): Transport | null;
}

/**
 * Clamp the caller-supplied timeout against the remaining inbound deadline.
 * A caller may shorten the deadline but never extend it.
 *
 * @internal
 */
export function clampTimeout(caller: number | undefined, remaining: number | undefined): number | undefined {
    if (caller === undefined) return remaining;
    if (remaining === undefined) return caller;
    return Math.min(caller, remaining);
}

/**
 * Split a catalog method key `"${typeName}/${Method}"` into its parts. The
 * `typeName` itself contains dots (never slashes), so we split on the LAST
 * slash — identical to the codegen key format and the ConnectRPC URL convention.
 *
 * @internal
 */
function splitMethodKey(method: string): { typeName: string; methodName: string } | null {
    const slash = method.lastIndexOf("/");
    if (slash <= 0 || slash === method.length - 1) return null;
    return { typeName: method.slice(0, slash), methodName: method.slice(slash + 1) };
}

/**
 * Message-framing headers that the in-process router transport tags onto
 * responses but that are illegal in gRPC/HTTP-2 trailers. A `ctx.call` error
 * re-enters the caller's response, so if it carried these in its metadata the
 * outer HTTP-2 server would emit invalid trailers (`NGHTTP2_PROTOCOL_ERROR` on
 * the client). Strip them so the downstream `Code` surfaces cleanly.
 *
 * @internal
 */
const NON_TRAILER_HEADERS = ["content-length", "content-type", "content-encoding"] as const;

/**
 * Sanitize an error propagated out of `ctx.call`/`ctx.stream`: remove framing
 * headers from a `ConnectError`'s metadata (see {@link NON_TRAILER_HEADERS}).
 * Returns the error unchanged otherwise.
 *
 * @internal
 */
function sanitizeCallError(error: unknown): unknown {
    if (error instanceof ConnectError) {
        for (const name of NON_TRAILER_HEADERS) error.metadata.delete(name);
    }
    return error;
}

/**
 * Per-server engine that materializes `ctx.call` and wraps user handlers so
 * they receive a Connectum {@link Context}.
 *
 * @internal
 */
export class CatalogDispatcher {
    private readonly host: CatalogDispatchHost;

    constructor(host: CatalogDispatchHost) {
        this.host = host;
    }

    /**
     * Wrap a user service implementation so every method receives a Connectum
     * {@link Context} (forwarding the real `HandlerContext` + `ctx.call`) in
     * place of the raw `HandlerContext`. Returns a ConnectRPC `ServiceImpl`
     * suitable for `router.service(descriptor, impl)`.
     */
    wrapHandlers<S extends DescService>(_descriptor: S, handlers: ConnectumServiceImpl<S>): ServiceImpl<S> {
        const source = handlers as Record<string, (request: unknown, context: Context) => unknown>;
        const wrapped: Record<string, (request: unknown, hctx: HandlerContext) => unknown> = {};
        for (const key of Object.keys(source)) {
            const userImpl = source[key];
            if (userImpl === undefined) continue;
            wrapped[key] = (request, hctx) => userImpl(request, this.makeContext(hctx));
        }
        return wrapped as unknown as ServiceImpl<S>;
    }

    /**
     * Build the Connectum {@link Context} for a single request. Delegates every
     * `HandlerContext` field to `hctx` via the prototype chain (so `signal` and
     * `timeoutMs()` are read LIVE at `ctx.call` time, not snapshotted) and adds
     * the typed `call` closure. The cast on `call` is the single public-surface
     * cast for the whole feature (D-FA / task 2.9).
     */
    makeContext(hctx: HandlerContext): Context {
        const ctx = Object.create(hctx) as Context;
        const call = ((method: string, request: unknown, options?: CallOptions): Promise<unknown> => this._dispatchUnary(method, request, options, hctx)) as Context["call"];
        const stream = ((method: string): unknown => this._makeStreamHandle(method, hctx)) as Context["stream"];
        Object.defineProperty(ctx, "call", { value: call, enumerable: false, writable: false, configurable: false });
        Object.defineProperty(ctx, "stream", { value: stream, enumerable: false, writable: false, configurable: false });
        return ctx;
    }

    /**
     * Runtime dispatch for a unary `ctx.call`. Throws `ConnectError` with a
     * `Code` describing the operational failure (the split error model reserves
     * `CatalogConfigError` for construction/startup configuration mistakes).
     *
     * @internal
     */
    private async _dispatchUnary(method: string, request: unknown, options: CallOptions | undefined, hctx: HandlerContext): Promise<unknown> {
        const { typeName, descMethod } = this._lookupCatalogMethod(method);
        if (descMethod.methodKind !== "unary") {
            throw new ConnectError(`ctx.call: "${method}" is a streaming method — use ctx.stream instead.`, Code.Unimplemented);
        }

        const transport = this._resolveTransport(typeName, options?.endpoint);

        // Cascade: inject the inbound signal/deadline unless explicitly overridden.
        const signal = options?.signal ?? hctx.signal;
        const timeoutMs = clampTimeout(options?.timeoutMs, hctx.timeoutMs());
        const headers = this._buildHeaders(hctx, options);

        try {
            const response = await transport.unary(
                descMethod as DescMethodUnary<DescMessage, DescMessage>,
                signal,
                timeoutMs,
                headers,
                request as MessageInitShape<DescMessage>,
                hctx.values,
            );
            return response.message;
        } catch (error) {
            throw sanitizeCallError(error);
        }
    }

    /**
     * Resolve a catalog method key to its `(typeName, DescMethod)`. Throws the
     * operational `ConnectError` for a missing catalog / unknown service /
     * unknown method (the kind check is left to the caller).
     *
     * @internal
     */
    private _lookupCatalogMethod(method: string): { typeName: string; descMethod: DescMethod } {
        const parts = splitMethodKey(method);
        if (parts === null) {
            throw new ConnectError(`ctx: malformed method key "${method}" (expected "\${typeName}/\${Method}").`, Code.Unimplemented);
        }
        const { typeName, methodName } = parts;

        const catalog = this.host.catalog;
        if (catalog === undefined) {
            throw new ConnectError("ctx: no catalog is configured; pass createServer({ catalog }) to enable cross-service calls.", Code.FailedPrecondition);
        }

        const descriptor = catalog[typeName];
        if (descriptor === undefined) {
            throw new ConnectError(`ctx: unknown service "${typeName}" (no such key in the catalog).`, Code.Unimplemented);
        }

        const descMethod = descriptor.methods.find((m) => m.name === methodName);
        if (descMethod === undefined) {
            throw new ConnectError(`ctx: "${typeName}" has no method "${methodName}".`, Code.Unimplemented);
        }
        return { typeName, descMethod };
    }

    /**
     * Build the kind-specific factory returned by `ctx.stream`. Validation
     * (catalog/service/method) is eager — calling `ctx.stream` on an unknown or
     * unary method throws here; operational failures (resolver/transport)
     * surface lazily on iteration / `close()`.
     *
     * @internal
     */
    private _makeStreamHandle(method: string, hctx: HandlerContext): unknown {
        const { typeName, descMethod } = this._lookupCatalogMethod(method);
        switch (descMethod.methodKind) {
            case "server_streaming":
                return (request: unknown, options?: CallOptions): AsyncIterable<unknown> => this._serverStream(typeName, descMethod, request, options, hctx);
            case "client_streaming":
                return (options?: CallOptions): ClientStreamHandle<unknown, unknown> => this._clientStream(typeName, descMethod, options, hctx);
            case "bidi_streaming":
                return (options?: CallOptions): BidiStreamHandle<unknown, unknown> => this._bidiStream(typeName, descMethod, options, hctx);
            default:
                throw new ConnectError(`ctx.stream: "${method}" is a unary method — use ctx.call instead.`, Code.Unimplemented);
        }
    }

    /** Server-streaming: one request in, an `AsyncIterable` of responses out. @internal */
    private _serverStream(typeName: string, descMethod: DescMethod, request: unknown, options: CallOptions | undefined, hctx: HandlerContext): AsyncIterable<unknown> {
        const dispatcher = this;
        return {
            async *[Symbol.asyncIterator]() {
                try {
                    const { transport, signal, timeoutMs, headers } = dispatcher._prepareStream(typeName, options, hctx);
                    const input = singleInput(request as MessageInitShape<DescMessage>);
                    const response = await transport.stream(descMethod as DescMethodStreaming<DescMessage, DescMessage>, signal, timeoutMs, headers, input, hctx.values);
                    yield* response.message;
                } catch (error) {
                    throw sanitizeCallError(error);
                }
            },
        };
    }

    /** Client-streaming: push N requests, `close()` resolves the single response. @internal */
    private _clientStream(typeName: string, descMethod: DescMethod, options: CallOptions | undefined, hctx: HandlerContext): ClientStreamHandle<unknown, unknown> {
        const queue = createInputQueue<MessageInitShape<DescMessage>>();
        const responsePromise = (async (): Promise<unknown> => {
            try {
                const { transport, signal, timeoutMs, headers } = this._prepareStream(typeName, options, hctx);
                const response = await transport.stream(descMethod as DescMethodStreaming<DescMessage, DescMessage>, signal, timeoutMs, headers, queue.iterable, hctx.values);
                for await (const message of response.message) {
                    return message;
                }
                throw new ConnectError(`ctx.stream: client-streaming "${descMethod.name}" produced no response.`, Code.Internal);
            } catch (error) {
                throw sanitizeCallError(error);
            }
        })();
        // Avoid an unhandled rejection before the caller awaits close().
        responsePromise.catch(() => {});
        return {
            send: (request) => queue.push(request as MessageInitShape<DescMessage>),
            close: () => {
                queue.close();
                return responsePromise;
            },
        };
    }

    /** Bidi-streaming: push requests while iterating `responses`; `close()` ends the send half. @internal */
    private _bidiStream(typeName: string, descMethod: DescMethod, options: CallOptions | undefined, hctx: HandlerContext): BidiStreamHandle<unknown, unknown> {
        const queue = createInputQueue<MessageInitShape<DescMessage>>();
        return {
            send: (request) => queue.push(request as MessageInitShape<DescMessage>),
            close: () => queue.close(),
            responses: this._bidiResponses(typeName, descMethod, options, hctx, queue.iterable),
        };
    }

    /** @internal */
    private async *_bidiResponses(
        typeName: string,
        descMethod: DescMethod,
        options: CallOptions | undefined,
        hctx: HandlerContext,
        input: AsyncIterable<MessageInitShape<DescMessage>>,
    ): AsyncIterable<unknown> {
        try {
            const { transport, signal, timeoutMs, headers } = this._prepareStream(typeName, options, hctx);
            const response = await transport.stream(descMethod as DescMethodStreaming<DescMessage, DescMessage>, signal, timeoutMs, headers, input, hctx.values);
            yield* response.message;
        } catch (error) {
            throw sanitizeCallError(error);
        }
    }

    /**
     * Resolve transport + cascade for a streaming call (shared by all kinds).
     *
     * @internal
     */
    private _prepareStream(
        typeName: string,
        options: CallOptions | undefined,
        hctx: HandlerContext,
    ): { transport: Transport; signal: AbortSignal; timeoutMs: number | undefined; headers: Headers | undefined } {
        const transport = this._resolveTransport(typeName, options?.endpoint);
        const signal = options?.signal ?? hctx.signal;
        const timeoutMs = clampTimeout(options?.timeoutMs, hctx.timeoutMs());
        const headers = this._buildHeaders(hctx, options);
        return { transport, signal, timeoutMs, headers };
    }

    /**
     * Compose outgoing headers: copy the allow-listed inbound headers, then
     * apply the caller's explicit `options.headers` (which win on conflict).
     * Returns `undefined` when nothing is set, so the transport sends no extra
     * headers.
     *
     * @internal
     */
    private _buildHeaders(hctx: HandlerContext, options: CallOptions | undefined): Headers | undefined {
        const out = new Headers();
        for (const name of this.host.propagateHeaders) {
            const value = hctx.requestHeader.get(name);
            if (value !== null) out.set(name, value);
        }
        if (options?.headers !== undefined) {
            for (const [key, value] of new Headers(options.headers)) {
                out.set(key, value);
            }
        }
        return [...out.keys()].length > 0 ? out : undefined;
    }

    /**
     * Pick the transport for a target service: the in-process transport when
     * mounted locally, otherwise the resolver-supplied transport.
     *
     * @internal
     */
    private _resolveTransport(typeName: string, endpoint: string | undefined): Transport {
        if (this.host.isLocal(typeName)) {
            return this.host.getLocalTransport();
        }
        let transport: Transport | null;
        try {
            transport = this.host.resolveRemoteTransport(typeName, endpoint);
        } catch (cause) {
            throw new ConnectError(`ctx.call: the remoteResolver threw while resolving "${typeName}".`, Code.Internal, undefined, undefined, cause);
        }
        if (transport === null) {
            const at = endpoint !== undefined ? ` (endpoint "${endpoint}")` : "";
            throw new ConnectError(`ctx.call: no route for "${typeName}"${at}: the resolver returned null.`, Code.Unavailable);
        }
        return transport;
    }
}
