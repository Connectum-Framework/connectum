/**
 * Service Catalog — runtime primitives for declarative cross-service calls.
 *
 * A catalog is a plain readonly `Record<protoTypeName, DescService>`. It carries
 * no topology — what is local vs remote lives in `enabledServices` / a
 * `RemoteResolver` at boot, never in proto. The `@connectum/protoc-gen-catalog`
 * buf plugin generates a `serviceCatalog` object plus the type augmentations that
 * make positional `ctx.call(...)` / `ctx.stream(...)` type-safe.
 *
 * @module serviceCatalog
 */

import type { DescService } from "@bufbuild/protobuf";
import { CatalogConfigError } from "./catalogErrors.ts";

/**
 * A readonly registry mapping a proto service `typeName`
 * (e.g. `"orders.v1.OrdersService"`) to its `DescService` descriptor.
 */
export type ServiceCatalog = Readonly<Record<string, DescService>>;

/**
 * Module-augmentation target for type-safe **unary** `ctx.call(method, request)`.
 *
 * `@connectum/protoc-gen-catalog` augments this with one entry per unary RPC,
 * keyed `"<typeName>/<method>"` → `{ request; response }`. It starts empty so
 * applications that do not use catalog calls need no generated augmentation.
 * Without registered keys, `ctx.call` has no callable procedure names.
 */
// biome-ignore lint/suspicious/noEmptyInterface: module-augmentation target, populated by codegen
export interface ConnectumCallMap {}

/**
 * Module-augmentation target for type-safe **streaming** `ctx.stream(method, ...)`.
 *
 * Augmented per streaming RPC, keyed `"<typeName>/<method>"` →
 * `{ request; response; kind }` where `kind` is `"server-stream"`,
 * `"client-stream"`, or `"bidi"`. Unary RPCs never appear here — they go to
 * {@link ConnectumCallMap}.
 */
// biome-ignore lint/suspicious/noEmptyInterface: module-augmentation target, populated by codegen
export interface ConnectumStreamMap {}

/**
 * Build a {@link ServiceCatalog} from a literal record, preserving the literal
 * key type for downstream inference. Equivalent to writing the record inline,
 * but freezes the result and documents intent.
 *
 * Throws {@link CatalogConfigError} if any key does not equal its descriptor's
 * `typeName` — a mis-keyed entry would bypass the duplicate-`typeName` intent
 * and break resolution by canonical type name.
 *
 * @example
 * ```ts
 * const catalog = defineCatalog({
 *   [OrdersService.typeName]: OrdersService,
 *   [InventoryService.typeName]: InventoryService,
 * });
 * ```
 */
export function defineCatalog<const T extends Record<string, DescService>>(record: T): Readonly<T> {
    assertCatalogShape(record, "defineCatalog");
    return Object.freeze({ ...record });
}

/**
 * Check that `catalog` is an object whose every key equals its descriptor's
 * `typeName`. {@link defineCatalog} runs it, and so do the entry points that
 * accept a catalog built by hand (`createServer`, `createCatalogClient`): a
 * mis-keyed entry would never be found by its canonical type name, and
 * `enabledServices` matching the wrong key would mount nothing.
 *
 * @param caller - the function that received the catalog, to prefix the message
 * @throws CatalogConfigError for a catalog that is not an object, an entry that is not a service descriptor, or a key that differs from its `typeName`
 * @internal
 */
export function assertCatalogShape(catalog: unknown, caller: string): void {
    if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) {
        throw new CatalogConfigError(
            `${caller}: catalog must be an object mapping each service typeName to its descriptor, got ${catalog === null ? "null" : Array.isArray(catalog) ? "an array" : typeof catalog}.`,
        );
    }
    for (const [key, descriptor] of Object.entries(catalog)) {
        const typeName = (descriptor as { typeName?: unknown } | null | undefined)?.typeName;
        if (typeof typeName !== "string") {
            throw new CatalogConfigError(`${caller}: catalog entry "${key}" is not a service descriptor (it has no typeName).`);
        }
        if (key !== typeName) {
            throw new CatalogConfigError(`${caller}: key "${key}" must match descriptor.typeName "${typeName}".`);
        }
    }
}

/**
 * Merge several catalogs into one.
 *
 * Throws {@link CatalogConfigError} on a duplicate `typeName`, or on a key that
 * does not equal its descriptor's `typeName`. TypeScript cannot catch a duplicate
 * whose two descriptors have an identical shape, so this
 * runtime check is mandatory rather than optional — a silent collision would
 * route calls to the wrong service.
 */
export function mergeCatalogs(...catalogs: readonly ServiceCatalog[]): ServiceCatalog {
    const merged: Record<string, DescService> = {};
    for (const catalog of catalogs) {
        for (const [typeName, descriptor] of Object.entries(catalog)) {
            if (typeName !== descriptor.typeName) {
                throw new CatalogConfigError(`mergeCatalogs: key "${typeName}" must match descriptor.typeName "${descriptor.typeName}".`);
            }
            if (Object.hasOwn(merged, typeName)) {
                throw new CatalogConfigError(`mergeCatalogs: duplicate typeName: "${typeName}"`);
            }
            merged[typeName] = descriptor;
        }
    }
    return Object.freeze(merged);
}
