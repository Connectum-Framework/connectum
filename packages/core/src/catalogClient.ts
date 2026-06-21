/**
 * Catalog client — the catalog-typed `call`/`stream` surface usable OUTSIDE a
 * `Server`.
 *
 * In-handler `ctx.call`/`ctx.stream` give catalog-typed, resolver-routed
 * cross-service calls — but only where a {@link Context} exists, i.e. inside a
 * Connectum service handler. An out-of-process caller (a Temporal worker, a
 * scheduler, a CLI) has no `Server` and no `HandlerContext`, so it would
 * otherwise hand-build `createClient(Service, transport)` per service and lose
 * the service-catalog typing and the {@link RemoteResolver} wiring.
 *
 * {@link createCatalogClient} closes that gap: it produces the SAME typed `call`
 * (unary) and `stream` (server/client/bidi) surface as the handler `ctx`, keyed
 * off the generated {@link ConnectumCallMap}/{@link ConnectumStreamMap}, but
 * resolves every target purely through the supplied {@link RemoteResolver}.
 * There is no in-process/local path here (no `Server`, no mounted services), so
 * a service the resolver cannot resolve is a clear `ConnectError`.
 *
 * Cascade differences vs. `ctx.call` (there is no inbound request to cascade
 * from): `signal`/`timeoutMs`/`headers` are taken verbatim from
 * {@link CallOptions}; `timeoutMs` is NOT clamped (nothing to clamp against),
 * no inbound headers are propagated, and no `ContextValues` are forwarded.
 *
 * @module catalogClient
 */

import type { DescMessage, DescMethodStreaming, DescMethodUnary } from "@bufbuild/protobuf";
import { Code, ConnectError, type Transport } from "@connectrpc/connect";
import {
    type CallFrame,
    dispatchUnaryCall,
    lookupCatalogMethod,
    openBidiStream,
    openClientStream,
    openServerStream,
    type ResolveStream,
    resolveRemoteTransportOrThrow,
} from "./catalogDispatcher.ts";
import type { BidiStreamHandle, CallOptions, CatalogCall, CatalogStream, ClientStreamHandle } from "./context.ts";
import type { RemoteResolver } from "./remoteResolver.ts";
import type { ServiceCatalog } from "./serviceCatalog.ts";

/**
 * Options for {@link createCatalogClient}.
 */
export interface CreateCatalogClientOptions {
    /**
     * The service catalog (a `Record<typeName, DescService>`) that backs typed
     * dispatch — the same object passed to `createServer({ catalog })`.
     */
    catalog: ServiceCatalog;
    /**
     * Maps a target service `typeName` to a ConnectRPC `Transport`. Required:
     * unlike a `Server`, a catalog client has no in-process/local path, so every
     * call is routed through the resolver. A resolver that returns `null` for a
     * target makes that call fail with `Code.Unavailable`.
     */
    resolver: RemoteResolver;
}

/**
 * A standalone, catalog-typed client. Exposes the SAME `call` (unary) and
 * `stream` (server/client/bidi) surface as the handler {@link Context}, keyed
 * off {@link ConnectumCallMap}/{@link ConnectumStreamMap}, without constructing
 * a `Server`.
 */
export interface CatalogClient {
    /**
     * Invoke a unary service in the catalog over the resolver-supplied
     * transport. With no augmentation of {@link ConnectumCallMap} this is
     * statically uncallable — exactly as on the handler `ctx`.
     *
     * Errors mirror `ctx.call`: no catalog / unknown service / unknown method /
     * wrong kind → `Code.FailedPrecondition`/`Code.Unimplemented`; resolver
     * returns `null` → `Code.Unavailable`; resolver throws → `Code.Internal`
     * (cause preserved).
     */
    call: CatalogCall;
    /**
     * Open a streaming call to a service in the catalog over the
     * resolver-supplied transport. Returns the same kind-specific factory as
     * `ctx.stream` (server-streaming → `AsyncIterable`; client-/bidi-streaming →
     * push handles).
     */
    stream: CatalogStream;
}

/**
 * Build a standalone {@link CatalogClient} from a {@link ServiceCatalog} and a
 * {@link RemoteResolver}.
 *
 * @example
 * ```ts
 * import { createCatalogClient, mapResolver } from "@connectum/core";
 * import { serviceCatalog } from "./gen/catalog.ts"; // @connectum/protoc-gen-catalog
 *
 * const client = createCatalogClient({
 *   catalog: serviceCatalog,
 *   resolver: mapResolver({
 *     "fleet.v1.FleetService": createGrpcTransport({ baseUrl: process.env.FLEET_ADDR }),
 *   }),
 * });
 *
 * // Fully typed off the generated catalog — same surface as ctx.call:
 * const trip = await client.call("trip.v1.TripService/StartTrip", { vehicleId });
 * ```
 */
export function createCatalogClient(options: CreateCatalogClientOptions): CatalogClient {
    const { catalog, resolver } = options;

    // Cache the resolved transport per unique (typeName, endpoint) key, matching
    // the Server's `_resolveRemoteTransport` so the resolver runs at most once
    // per route (mirrors the RemoteResolver caching contract).
    const transportCache = new Map<string, Transport>();

    function resolveTransport(typeName: string, endpoint: string | undefined, caller: string): Transport {
        const key = `${typeName} ${endpoint ?? ""}`;
        const cached = transportCache.get(key);
        if (cached !== undefined) return cached;
        const transport = resolveRemoteTransportOrThrow(resolver, typeName, endpoint, caller);
        transportCache.set(key, transport);
        return transport;
    }

    /**
     * Build the per-call frame from {@link CallOptions} directly. No inbound
     * request exists out-of-process, so nothing cascades: the signal/deadline/
     * headers are used verbatim and no `ContextValues` are forwarded.
     */
    function buildFrame(callOptions: CallOptions | undefined): CallFrame {
        return {
            signal: callOptions?.signal,
            timeoutMs: callOptions?.timeoutMs,
            headers: callOptions?.headers,
            contextValues: undefined,
        };
    }

    // `call` is async so that EVERY failure (lookup, resolution, transport)
    // surfaces as a rejected promise — identical to the handler `ctx.call`,
    // whose `_dispatchUnary` is itself async. Callers always `await`.
    const call = (async (method: string, request: unknown, callOptions?: CallOptions): Promise<unknown> => {
        const { typeName, descMethod } = lookupCatalogMethod(catalog, method, "catalogClient.call");
        if (descMethod.methodKind !== "unary") {
            throw new ConnectError(`catalogClient.call: "${method}" is a streaming method — use client.stream instead.`, Code.Unimplemented);
        }
        const transport = resolveTransport(typeName, callOptions?.endpoint, "catalogClient.call");
        return dispatchUnaryCall(transport, descMethod as DescMethodUnary<DescMessage, DescMessage>, request, buildFrame(callOptions));
    }) as CatalogCall;

    const stream = ((method: string): unknown => makeStreamHandle(method)) as CatalogStream;

    // The lazy resolution thunk for a streaming call: resolve the transport and
    // snapshot the frame. Deferred into the opener body so a resolver/transport
    // failure surfaces on iteration/`close()`, matching the handler `ctx.stream`.
    function streamResolver(typeName: string, callOptions: CallOptions | undefined): ResolveStream {
        return () => ({
            transport: resolveTransport(typeName, callOptions?.endpoint, "catalogClient.stream"),
            frame: buildFrame(callOptions),
        });
    }

    function makeStreamHandle(method: string): unknown {
        const { typeName, descMethod } = lookupCatalogMethod(catalog, method, "catalogClient.stream");
        switch (descMethod.methodKind) {
            case "server_streaming":
                return (request: unknown, callOptions?: CallOptions): AsyncIterable<unknown> =>
                    openServerStream(streamResolver(typeName, callOptions), descMethod as DescMethodStreaming<DescMessage, DescMessage>, request);
            case "client_streaming":
                return (callOptions?: CallOptions): ClientStreamHandle<unknown, unknown> =>
                    openClientStream(streamResolver(typeName, callOptions), descMethod as DescMethodStreaming<DescMessage, DescMessage>);
            case "bidi_streaming":
                return (callOptions?: CallOptions): BidiStreamHandle<unknown, unknown> =>
                    openBidiStream(streamResolver(typeName, callOptions), descMethod as DescMethodStreaming<DescMessage, DescMessage>);
            default:
                throw new ConnectError(`catalogClient.stream: "${method}" is a unary method — use client.call instead.`, Code.Unimplemented);
        }
    }

    return { call, stream };
}
