/**
 * RemoteResolver — resolves a remote (non-locally-mounted) service to a
 * ConnectRPC `Transport`.
 *
 * The framework caches the result per unique `(typeName, endpoint)` key, so a
 * resolver MUST be **synchronous** and MUST NOT perform network I/O (TCP dial,
 * DNS lookup) — it only maps a service identity to a lazily-connecting
 * `Transport`. Returning `null` means "no route" → the call fails with
 * `Code.Unavailable`. Anything else that is not a `Transport` (a string, a
 * `Promise` from an `async` resolver, `undefined`) fails the call with
 * `Code.Internal` naming the service, and is not cached.
 *
 * @module remoteResolver
 */

import type { Transport } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { CatalogConfigError } from "./catalogErrors.ts";

/** Build a gRPC (HTTP/2) transport for a resolved base URL — the default for the URL-based resolvers. */
function defaultCreateTransport(baseUrl: string): Transport {
    return createGrpcTransport({ baseUrl });
}

/** A resolver factory's map argument must be an object: anything else would only fail on the first call, as a lookup on `undefined`. */
function assertMap(map: unknown, caller: string): void {
    if (typeof map !== "object" || map === null) {
        throw new CatalogConfigError(`${caller}: map must be an object keyed by service typeName, got ${map === null ? "null" : typeof map}.`);
    }
}

/** `createTransport` is optional; when given it is called for every resolution, so a non-function would fail on the first call. */
function assertCreateTransport(createTransport: unknown, caller: string): void {
    if (createTransport !== undefined && typeof createTransport !== "function") {
        throw new CatalogConfigError(`${caller}: createTransport must be a function that builds a Transport from a base URL, got ${typeof createTransport}.`);
    }
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
 * A resolver backed by an explicit `{ [typeName]: Transport }` map, an exact
 * allow-list: only the keys the map owns resolve. Every other `typeName`
 * resolves to `null` (→ `Code.Unavailable`), including names that exist on
 * `Object.prototype` (`constructor`, `toString`, `hasOwnProperty`, `valueOf`,
 * `__proto__`). A key the map owns resolves even when its name is also an
 * `Object.prototype` member. The lookup stays live: entries added to the map
 * after the resolver was created are honoured.
 */
export function mapResolver(map: Readonly<Record<string, Transport>>): RemoteResolver {
    assertMap(map, "mapResolver");
    return ({ typeName }) => (Object.hasOwn(map, typeName) ? (map[typeName] ?? null) : null);
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
    if (typeof options !== "object" || options === null) {
        throw new CatalogConfigError(`dnsResolver: options must be an object with a template, got ${options === null ? "null" : typeof options}.`);
    }
    if (typeof options.template !== "string" || options.template.length === 0) {
        throw new CatalogConfigError(
            `dnsResolver: template must be a non-empty string such as "http://{shortName}.prod.svc.cluster.local:50051", got ${JSON.stringify(options.template) ?? String(options.template)}.`,
        );
    }
    assertCreateTransport(options.createTransport, "dnsResolver");
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
 * @example
 * ```ts
 * import { createCatalogClient, perServiceEnvResolver } from "@connectum/core";
 * import { serviceCatalog } from "./gen/catalog.gen.ts";
 *
 * // Generate the catalog from the Greeter proto and set GREETER_URL
 * // to its server's HTTP/2 base URL before running this example.
 * const client = createCatalogClient({
 *   catalog: serviceCatalog,
 *   resolver: perServiceEnvResolver({
 *     "greeter.v1.GreeterService": "GREETER_URL",
 *   }),
 * });
 * const greeting = await client.call("greeter.v1.GreeterService/SayHello", { name: "Alice" });
 * console.log(greeting.message); // "Hello, Alice!"
 * ```
 */
export function perServiceEnvResolver(map: Readonly<Record<string, string>>, options?: PerServiceEnvResolverOptions): RemoteResolver {
    assertMap(map, "perServiceEnvResolver");
    assertCreateTransport(options?.createTransport, "perServiceEnvResolver");
    const create = options?.createTransport ?? defaultCreateTransport;
    return ({ typeName }) => {
        const envVar = map[typeName];
        if (!envVar) return null;
        const baseUrl = process.env[envVar]?.trim();
        if (!baseUrl) return null;
        return create(baseUrl);
    };
}
