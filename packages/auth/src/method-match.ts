/**
 * Method pattern matching utility
 *
 * Shared logic for matching gRPC methods against patterns.
 * Used by both auth and authz interceptors.
 *
 * @module method-match
 */

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
