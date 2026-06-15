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
 * that a project with no generated catalog still type-checks (calls are then
 * untyped rather than a hard error).
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
    for (const [key, descriptor] of Object.entries(record)) {
        if (key !== descriptor.typeName) {
            throw new CatalogConfigError(`defineCatalog: key "${key}" must match descriptor.typeName "${descriptor.typeName}".`);
        }
    }
    return Object.freeze({ ...record });
}

/**
 * Merge several catalogs into one.
 *
 * Throws {@link CatalogConfigError} on a duplicate `typeName`, or on a key that
 * does not equal its descriptor's `typeName`. TypeScript cannot catch a duplicate
 * whose two descriptors have an identical shape (polyrepo finding F3), so this
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
