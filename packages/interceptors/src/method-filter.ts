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

type AnyRpcFn = (req: UnaryRequest | StreamRequest) => Promise<UnaryResponse | StreamResponse>;

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

    for (const [pattern, interceptors] of Object.entries(methods)) {
        if (pattern === "*") {
            globalInterceptors.push(...interceptors);
        } else if (pattern.endsWith("/*")) {
            const serviceName = pattern.slice(0, -2);
            if (serviceName.length === 0) {
                throw new Error(`Invalid method filter pattern: "${pattern}". Service name before "/*" must not be empty.`);
            }
            const existing = serviceMap.get(serviceName);
            if (existing) {
                existing.push(...interceptors);
            } else {
                serviceMap.set(serviceName, [...interceptors]);
            }
        } else if (pattern.includes("/")) {
            const existing = exactMap.get(pattern);
            if (existing) {
                existing.push(...interceptors);
            } else {
                exactMap.set(pattern, [...interceptors]);
            }
        } else {
            throw new Error(`Invalid method filter pattern: "${pattern}". Expected "*", "Service/*", or "Service/Method".`);
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
