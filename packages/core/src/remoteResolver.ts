/**
 * RemoteResolver — resolves a remote (non-locally-mounted) service to a
 * ConnectRPC `Transport`.
 *
 * The framework caches the result per unique `(typeName, endpoint)` key, so a
 * resolver MUST be **synchronous** and MUST NOT perform network I/O (TCP dial,
 * DNS lookup) — it only maps a service identity to a lazily-connecting
 * `Transport`. Returning `null` means "no route" → the call fails with
 * `Code.Unavailable`.
 *
 * @module remoteResolver
 */

import type { Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";

/** Build a gRPC (HTTP/2) transport for a resolved base URL — the default for the URL-based resolvers. */
function defaultCreateTransport(baseUrl: string): Transport {
    return createGrpcTransport({ baseUrl });
}

/** Derive the short service name from a proto typeName: last segment, lower-cased, minus a trailing `Service`. */
function shortNameOf(typeName: string): string {
    const last = typeName.split(".").pop() ?? typeName;
    return last.replace(/Service$/, "").toLowerCase();
}

/** Context handed to a {@link RemoteResolver} for a single resolution. */
export interface ResolverContext {
    /** Proto service `typeName`, e.g. `"orders.v1.OrdersService"`. */
    readonly typeName: string;
    /** Opaque endpoint hint from `CallOptions.endpoint` (polymorphic deployments). */
    readonly endpoint?: string;
}

/**
 * Resolve a remote service to a `Transport`, or `null` if there is no route.
 * Synchronous by contract — see the module note.
 */
export type RemoteResolver = (ctx: ResolverContext) => Transport | null;

/**
 * A resolver that routes every remote service to the same `Transport`. Useful
 * for a single upstream (sidecar, gateway) that fronts all remote services.
 */
export function singleTransportResolver(transport: Transport): RemoteResolver {
    return () => transport;
}

/**
 * A resolver backed by an explicit `{ [typeName]: Transport }` map. Unknown
 * typeNames resolve to `null` (→ `Code.Unavailable`).
 */
export function mapResolver(map: Readonly<Record<string, Transport>>): RemoteResolver {
    return ({ typeName }) => map[typeName] ?? null;
}

/** Options for {@link dnsResolver}. */
export interface DnsResolverOptions {
    /**
     * URL template with `{shortName}` (alias `{name}`) placeholders. The short
     * name is the last `typeName` segment, lower-cased, minus a trailing
     * `Service` (e.g. `orders.v1.OrdersService` → `orders`). A k8s/DNS route is
     * expressed directly, e.g. `"http://{shortName}.prod.svc.cluster.local:50051"`.
     */
    readonly template: string;
    /** Build a `Transport` from the resolved base URL. Defaults to a gRPC (HTTP/2) transport. */
    readonly createTransport?: (baseUrl: string) => Transport;
}

/**
 * A resolver that derives a base URL per service from a DNS-style template and
 * builds a transport for it. Mirrors typical container/k8s service-name routing.
 * Always resolves (never `null`) — the template is assumed to cover every remote
 * service; use {@link mapResolver} for an explicit allow-list.
 */
export function dnsResolver(options: DnsResolverOptions): RemoteResolver {
    const create = options.createTransport ?? defaultCreateTransport;
    return ({ typeName }) => {
        const shortName = shortNameOf(typeName);
        const baseUrl = options.template.replaceAll("{shortName}", shortName).replaceAll("{name}", shortName);
        return create(baseUrl);
    };
}

/** Options for {@link perServiceEnvResolver}. */
export interface PerServiceEnvResolverOptions {
    /** Build a `Transport` from the resolved base URL. Defaults to a gRPC (HTTP/2) transport. */
    readonly createTransport?: (baseUrl: string) => Transport;
}

/**
 * A resolver backed by per-service environment variables: `map` pairs each
 * `typeName` with the name of the env var holding its base URL. A service with
 * no mapping, or whose env var is unset/empty, resolves to `null`
 * (→ `Code.Unavailable`). Replaces hand-rolled env registries in boot code.
 *
 * @example `perServiceEnvResolver({ "orders.v1.OrdersService": "ORDERS_URL" })`
 */
export function perServiceEnvResolver(map: Readonly<Record<string, string>>, options?: PerServiceEnvResolverOptions): RemoteResolver {
    const create = options?.createTransport ?? defaultCreateTransport;
    return ({ typeName }) => {
        const envVar = map[typeName];
        if (!envVar) return null;
        const baseUrl = process.env[envVar];
        if (!baseUrl) return null;
        return create(baseUrl);
    };
}
