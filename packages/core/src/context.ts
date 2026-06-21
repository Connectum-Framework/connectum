/**
 * Connectum handler context.
 *
 * Service handlers registered through {@link defineService} receive a
 * {@link Context} as their second argument. `Context` forwards every field of
 * the underlying ConnectRPC `HandlerContext` (so `signal`, `timeoutMs()`,
 * `requestHeader`, `values`, … keep working) and adds the typed `call`
 * primitive for declarative cross-service calls driven by the service catalog.
 *
 * The `call` map is populated by module augmentation of {@link ConnectumCallMap}
 * (emitted by `@connectum/protoc-gen-catalog`, or hand-written in tests). With
 * no augmentation `keyof ConnectumCallMap` is `never`, so `ctx.call` is
 * statically uncallable — exactly the right default for a service that makes no
 * cross-service calls.
 *
 * @module context
 */

import type {
    DescMethod,
    DescMethodBiDiStreaming,
    DescMethodClientStreaming,
    DescMethodServerStreaming,
    DescMethodUnary,
    DescService,
    MessageInitShape,
    MessageShape,
} from "@bufbuild/protobuf";
import type { HandlerContext } from "@connectrpc/connect";
import type { ConnectumCallMap, ConnectumStreamMap } from "./serviceCatalog.ts";

/**
 * Per-call overrides for {@link Context.call}.
 *
 * Every field is optional; omitted dimensions cascade from the incoming
 * request (see the auto-injection rules on {@link Context.call}). This is the
 * Connectum catalog `CallOptions`, intentionally distinct from
 * `@connectrpc/connect`'s client `CallOptions`.
 */
export type CallOptions = {
    /**
     * Abort signal for the outgoing call. When omitted, the incoming request's
     * `ctx.signal` is injected, so cancelling the inbound RPC cancels every
     * in-flight `ctx.call`. A supplied signal **replaces** the cascade (it is
     * not linked with `ctx.signal`).
     */
    signal?: AbortSignal;
    /**
     * Timeout in milliseconds. When omitted, the remaining inbound deadline
     * (`ctx.timeoutMs()`) is injected. A caller may **shorten** the deadline,
     * never extend it (the effective value is `min(timeoutMs, remaining)`).
     */
    timeoutMs?: number;
    /**
     * Extra request headers. Only these explicit headers are sent; no inbound
     * headers are auto-propagated (trace context flows implicitly via the OTel
     * client interceptor in `outgoingInterceptors`).
     */
    headers?: HeadersInit;
    /**
     * Opaque endpoint hint forwarded to the configured `remoteResolver` for
     * services reachable at several endpoints. Ignored for locally-mounted
     * services.
     */
    endpoint?: string;
};

/**
 * Push handle for a client-streaming catalog call: send N requests, then
 * `close()` to receive the single aggregated response.
 */
export interface ClientStreamHandle<Req, Res> {
    /** Enqueue one request message. */
    send(request: Req): void;
    /** End the request stream and resolve with the server's single response. */
    close(): Promise<Res>;
}

/**
 * Push handle for a bidi-streaming catalog call: `send()` requests while
 * iterating `responses`; `close()` ends only the request (send) half — the
 * response half keeps yielding until the server completes.
 */
export interface BidiStreamHandle<Req, Res> {
    /** Enqueue one request message. */
    send(request: Req): void;
    /** End the request (send) half; the response half is unaffected. */
    close(): void;
    /** The server's response messages, in order. */
    readonly responses: AsyncIterable<Res>;
}

/**
 * Maps a {@link ConnectumStreamMap} entry to the ergonomic shape returned by
 * {@link Context.stream}, discriminated by the entry's `kind`.
 */
export type StreamReturn<E> = E extends { kind: "server-stream"; request: infer Req; response: infer Res }
    ? (request: Req, options?: CallOptions) => AsyncIterable<Res>
    : E extends { kind: "client-stream"; request: infer Req; response: infer Res }
      ? (options?: CallOptions) => ClientStreamHandle<Req, Res>
      : E extends { kind: "bidi"; request: infer Req; response: infer Res }
        ? (options?: CallOptions) => BidiStreamHandle<Req, Res>
        : never;

/**
 * The typed **unary** catalog-call surface: `call(method, request, options?)`
 * keyed off {@link ConnectumCallMap}. Shared by the handler {@link Context} and
 * the standalone `CatalogClient` (`createCatalogClient`) so both expose an
 * identical, fully-typed `call`.
 *
 * @typeParam K - A `"${typeName}/${Method}"` key of {@link ConnectumCallMap}.
 */
export type CatalogCall = <K extends keyof ConnectumCallMap>(method: K, request: ConnectumCallMap[K]["request"], options?: CallOptions) => Promise<ConnectumCallMap[K]["response"]>;

/**
 * The typed **streaming** catalog-call surface: `stream(method)` returns a
 * kind-specific factory keyed off {@link ConnectumStreamMap}. Shared by the
 * handler {@link Context} and the standalone `CatalogClient`.
 *
 * @typeParam K - A `"${typeName}/${Method}"` key of {@link ConnectumStreamMap}.
 */
export type CatalogStream = <K extends keyof ConnectumStreamMap>(method: K) => StreamReturn<ConnectumStreamMap[K]>;

/**
 * The context object passed to every Connectum service handler.
 *
 * Extends ConnectRPC's `HandlerContext` (all of its fields remain available)
 * and adds {@link Context.call} (unary catalog calls) and {@link Context.stream}
 * (streaming catalog calls).
 */
export interface Context extends HandlerContext {
    /**
     * Invoke a unary service in the catalog. The transport is chosen
     * automatically: an in-process call when the target is mounted locally,
     * otherwise the `remoteResolver`-supplied transport.
     *
     * `signal` and `timeoutMs` cascade from the incoming request unless
     * overridden in `options` (see {@link CallOptions}).
     *
     * @typeParam K - A `"${typeName}/${Method}"` key of {@link ConnectumCallMap}.
     */
    call: CatalogCall;

    /**
     * Open a streaming call to a service in the catalog. Returns a kind-specific
     * factory: server-streaming yields an `AsyncIterable`; client- and
     * bidi-streaming return push handles (see {@link ClientStreamHandle} /
     * {@link BidiStreamHandle}).
     *
     * On a mid-stream transport failure the iterator delivers the messages
     * received so far and then throws the terminal `ConnectError`.
     *
     * @typeParam K - A `"${typeName}/${Method}"` key of {@link ConnectumStreamMap}.
     */
    stream: CatalogStream;
}

/**
 * The implementation of a single RPC, receiving a Connectum {@link Context}.
 *
 * Mirrors `@connectrpc/connect`'s `MethodImpl` but substitutes `Context` for
 * the raw `HandlerContext`, so `ctx.call` is visible inside handlers.
 */
export type ConnectumMethodImpl<M extends DescMethod> =
    M extends DescMethodUnary<infer I, infer O>
        ? (request: MessageShape<I>, context: Context) => Promise<MessageInitShape<O>> | MessageInitShape<O>
        : M extends DescMethodServerStreaming<infer I, infer O>
          ? (request: MessageShape<I>, context: Context) => AsyncIterable<MessageInitShape<O>>
          : M extends DescMethodClientStreaming<infer I, infer O>
            ? (requests: AsyncIterable<MessageShape<I>>, context: Context) => Promise<MessageInitShape<O>>
            : M extends DescMethodBiDiStreaming<infer I, infer O>
              ? (requests: AsyncIterable<MessageShape<I>>, context: Context) => AsyncIterable<MessageInitShape<O>>
              : never;

/**
 * The full implementation of a service: one {@link ConnectumMethodImpl} per
 * method. Accepted by {@link defineService} / {@link defineLazyService}.
 *
 * Mirrors `@connectrpc/connect`'s `ServiceImpl` with the Connectum
 * {@link Context}.
 */
export type ConnectumServiceImpl<Desc extends DescService> = {
    [P in keyof Desc["method"]]: ConnectumMethodImpl<Desc["method"][P]>;
};
