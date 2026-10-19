/**
 * Method pattern matching utility
 *
 * Shared logic for matching gRPC methods against patterns.
 * Used by both auth and authz interceptors.
 *
 * @module method-match
 */

/**
 * Refuse the catch-all pattern `"*"` in a `skipMethods` list.
 *
 * `skipMethods: ["*"]` switches the interceptor off for every method without saying
 * so, and it is almost always a leftover from debugging. Switching an interceptor off
 * is done by not registering it; skipping a whole service is done with `Service/*`.
 * (`"*"` stays valid in authorization rule `methods` and in `internalMethods`,
 * where "every method" is the point of the rule.)
 *
 * @param skipMethods - The `skipMethods` option as given by the caller
 * @throws {Error} When the list contains `"*"`
 */
export function assertNoCatchAllSkip(skipMethods: readonly string[] | undefined): void {
    if (skipMethods?.includes("*")) {
        throw new Error('@connectum/auth: skipMethods must not contain the catch-all pattern "*"; to disable this interceptor, do not register it, or list Service/* patterns');
    }
}

/**
 * Check if a method matches any of the given patterns.
 *
 * Patterns:
 * - "*" — matches all methods
 * - "Service/*" — matches all methods of a service
 * - "Service/Method" — matches exact method
 *
 * @param serviceName - Fully-qualified service name (e.g., "user.v1.UserService")
 * @param methodName - Method name (e.g., "GetUser")
 * @param patterns - Readonly array of match patterns
 * @returns true if the method matches any pattern
 */
export function matchesMethodPattern(serviceName: string, methodName: string, patterns: readonly string[]): boolean {
    if (patterns.length === 0) {
        return false;
    }

    const fullMethod = `${serviceName}/${methodName}`;

    for (const pattern of patterns) {
        if (pattern === "*") {
            return true;
        }
        if (pattern === fullMethod) {
            return true;
        }
        if (pattern.endsWith("/*")) {
            const servicePattern = pattern.slice(0, -2);
            if (serviceName === servicePattern) {
                return true;
            }
        }
    }

    return false;
}
