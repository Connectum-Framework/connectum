/**
 * Method filter interceptor
 *
 * Routes interceptors to specific methods based on wildcard pattern matching.
 * Provides declarative per-method interceptor configuration without boilerplate.
 *
 * @module method-filter
 */

import type { Interceptor, StreamRequest, StreamResponse, UnaryRequest, UnaryResponse } from "@connectrpc/connect";
import type { MethodFilterMap } from "./types.ts";
import { requireFunctionArray, requireOptionsObject } from "./validate.ts";

type AnyRpcFn = (req: UnaryRequest | StreamRequest) => Promise<UnaryResponse | StreamResponse>;

function invalidPattern(pattern: string): Error {
    return new Error(
        `Invalid method filter pattern: ${JSON.stringify(pattern)}. Expected "*", "Service/*", or "Service/Method", where Service and Method are not empty and contain no "*", "/" or whitespace.`,
    );
}

/**
 * A service or method name in a key must be non-empty and free of `*`, `/` and
 * whitespace. A call's key is `typeName/methodName`, so a key with a wildcard
 * inside a name, an extra slash or a stray space is one no call ever produces.
 * Case is not checked: that needs the registered services, which this
 * interceptor does not see.
 */
function requireNamePart(options: { pattern: string; part: string | undefined }): void {
    const { pattern, part } = options;
    if (part === undefined || !/^[^\s*/]+$/.test(part)) {
        throw invalidPattern(pattern);
    }
}

/**
 * Parse and validate method filter patterns at creation time.
 *
 * Splits patterns into 3 groups for O(1) lookup:
 * - globalInterceptors: interceptors for "*" pattern
 * - serviceMap: Map<serviceName, Interceptor[]> for "Service/*" patterns
 * - exactMap: Map<"Service/Method", Interceptor[]> for exact patterns
 *
 * @param methods - Method filter map
 * @returns Parsed pattern groups
 */
function parsePatterns(methods: MethodFilterMap): {
    globalInterceptors: Interceptor[];
    serviceMap: Map<string, Interceptor[]>;
    exactMap: Map<string, Interceptor[]>;
} {
    const globalInterceptors: Interceptor[] = [];
    const serviceMap = new Map<string, Interceptor[]>();
    const exactMap = new Map<string, Interceptor[]>();

    requireOptionsObject({ caller: "createMethodFilterInterceptor", name: "methods", value: methods });

    for (const [pattern, interceptors] of Object.entries(methods)) {
        requireFunctionArray({ caller: "createMethodFilterInterceptor", subject: `the interceptors of ${JSON.stringify(pattern)}`, value: interceptors });

        if (pattern === "*") {
            globalInterceptors.push(...interceptors);
        } else if (pattern.endsWith("/*")) {
            const serviceName = pattern.slice(0, -2);
            if (serviceName.length === 0) {
                throw new Error(`Invalid method filter pattern: "${pattern}". Service name before "/*" must not be empty.`);
            }
            requireNamePart({ pattern, part: serviceName });
            const existing = serviceMap.get(serviceName);
            if (existing) {
                existing.push(...interceptors);
            } else {
                serviceMap.set(serviceName, [...interceptors]);
            }
        } else if (pattern.includes("/")) {
            // Exactly one slash with a name on each side: any other shape is a key
            // that no call can ever produce (a call is `typeName/methodName`).
            const [serviceName, methodName, ...rest] = pattern.split("/");
            requireNamePart({ pattern, part: serviceName });
            requireNamePart({ pattern, part: methodName });
            if (rest.length > 0) {
                throw invalidPattern(pattern);
            }
            const existing = exactMap.get(pattern);
            if (existing) {
                existing.push(...interceptors);
            } else {
                exactMap.set(pattern, [...interceptors]);
            }
        } else {
            throw invalidPattern(pattern);
        }
    }

    return { globalInterceptors, serviceMap, exactMap };
}

/**
 * Compose an array of interceptors into a single interceptor chain.
 *
 * Each interceptor wraps the next, forming the standard ConnectRPC nesting:
 * interceptor1(interceptor2(interceptor3(next)))
 *
 * @param interceptors - Array of interceptors to compose
 * @param next - The final next function
 * @returns Composed handler function
 */
function composeInterceptors(interceptors: Interceptor[], next: AnyRpcFn): AnyRpcFn {
    // Build chain from right to left: last interceptor wraps next, etc.
    let handler = next;
    for (let i = interceptors.length - 1; i >= 0; i--) {
        const current = interceptors[i];
        if (current) {
            const currentNext = handler;
            handler = current(currentNext);
        }
    }
    return handler;
}

/**
 * Create a method filter interceptor that routes to per-method interceptors
 * based on wildcard pattern matching.
 *
 * Resolution order (all matching patterns execute):
 * 1. Global wildcard `"*"` (executed first)
 * 2. Service wildcard `"Service/*"` (executed second)
 * 3. Exact match `"Service/Method"` (executed last)
 *
 * Within each pattern, interceptors execute in array order.
 *
 * A key is one of the three forms above, where `Service` is the protobuf
 * fully-qualified service name and `Method` the method name, each non-empty and
 * free of `*`, `/` and whitespace. Any other key (`/Unary`, `Svc/`, `Svc/Un*`,
 * `a/b/*`, a wildcard as the service name, a key with a space) can never match a call, so it throws
 * an `Error` at creation. Each value must be an array of functions and the map
 * an object, otherwise a `TypeError` is thrown; a `null` or `undefined` entry is
 * not skipped. Names are compared exactly, case included: a key such as
 * `acme.v1.svc/unary` is well formed but matches nothing if the service is
 * `acme.v1.Svc`, and the interceptor cannot tell, because it does not see the
 * registered services.
 *
 * @param methods - Method pattern to interceptors mapping
 * @returns ConnectRPC interceptor
 *
 * @example Auth per service
 * ```typescript
 * import { createMethodFilterInterceptor } from '@connectum/interceptors';
 *
 * const perMethodInterceptor = createMethodFilterInterceptor({
 *   "*": [logRequest],
 *   "admin.v1.AdminService/*": [requireAdmin],
 *   "user.v1.UserService/DeleteUser": [requireAdmin, auditLog],
 * });
 *
 * const server = createServer({
 *   services: [routes],
 *   interceptors: [perMethodInterceptor],
 * });
 * ```
 *
 * @example Resilience per method
 * ```typescript
 * createMethodFilterInterceptor({
 *   "catalog.v1.CatalogService/GetProduct": [
 *     createTimeoutInterceptor({ duration: 5_000 }),
 *   ],
 *   "report.v1.ReportService/*": [
 *     createTimeoutInterceptor({ duration: 30_000 }),
 *     createCircuitBreakerInterceptor({ threshold: 3 }),
 *   ],
 * });
 * ```
 */
export function createMethodFilterInterceptor(methods: MethodFilterMap): Interceptor {
    const { globalInterceptors, serviceMap, exactMap } = parsePatterns(methods);

    return (next) => async (req: UnaryRequest | StreamRequest) => {
        const serviceName: string = req.service.typeName;
        const methodName: string = req.method.name;
        const key = `${serviceName}/${methodName}`;

        // Collect all matching interceptors in order: global -> service -> exact
        const matched: Interceptor[] = [];

        if (globalInterceptors.length > 0) {
            matched.push(...globalInterceptors);
        }

        const serviceInterceptors = serviceMap.get(serviceName);
        if (serviceInterceptors) {
            matched.push(...serviceInterceptors);
        }

        const exactInterceptors = exactMap.get(key);
        if (exactInterceptors) {
            matched.push(...exactInterceptors);
        }

        // No matching interceptors — pass through
        if (matched.length === 0) {
            return await next(req);
        }

        // Compose and execute matched interceptors
        const handler = composeInterceptors(matched, next);
        return await handler(req);
    };
}
