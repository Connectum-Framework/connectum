/**
 * CatalogConfigError — a configuration mistake in the service-catalog setup.
 *
 * This is a **programmer error**: it should fail loud with a stack trace rather
 * than be mapped to an RPC status code. It is thrown eagerly for misconfiguration
 * such as `server.client(Desc)` on a non-local service with no resolver,
 * `enabledServices` that is not a subset of the catalog, or a duplicate `typeName`
 * during `mergeCatalogs`.
 *
 * Operational failures (a resolver returning `null`, a network error, an unknown
 * `typeName` at `ctx.call` dispatch) stay `ConnectError` with the appropriate
 * Connect status code. This split (Q15) keeps developer mistakes distinct from
 * runtime failures.
 *
 * @module catalogErrors
 */

export class CatalogConfigError extends Error {
    override readonly name = "CatalogConfigError";

    constructor(message: string) {
        super(message);
        // Maintain a clean prototype chain across compiled targets.
        Object.setPrototypeOf(this, CatalogConfigError.prototype);
    }
}
