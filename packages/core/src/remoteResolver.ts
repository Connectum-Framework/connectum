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
