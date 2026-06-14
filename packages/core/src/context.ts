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
import type { ConnectumCallMap } from "./serviceCatalog.ts";

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
 * The context object passed to every Connectum service handler.
 *
 * Extends ConnectRPC's `HandlerContext` (all of its fields remain available)
 * and adds {@link Context.call}. `ctx.stream` for streaming catalog calls is
 * introduced in a follow-up; until then streaming handlers still receive the
 * full `HandlerContext` surface plus `ctx.call`.
 */
export interface Context extends HandlerContext {
    /**
     * Invoke another service in the catalog. The transport is chosen
     * automatically: an in-process call when the target is mounted locally,
     * otherwise the `remoteResolver`-supplied transport.
     *
     * `signal` and `timeoutMs` cascade from the incoming request unless
     * overridden in `options` (see {@link CallOptions}).
     *
     * @typeParam K - A `"${typeName}/${Method}"` key of {@link ConnectumCallMap}.
     */
    call<K extends keyof ConnectumCallMap>(method: K, request: ConnectumCallMap[K]["request"], options?: CallOptions): Promise<ConnectumCallMap[K]["response"]>;
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
