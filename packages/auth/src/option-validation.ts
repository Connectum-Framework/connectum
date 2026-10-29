/**
 * Checks of factory options that run when an interceptor is created.
 *
 * An option that can never work, or that would be read as something the caller did not mean,
 * is refused here with an error that names the factory, the option and the value, instead of
 * failing on the first request or silently opening access.
 *
 * @module option-validation
 */

import { inspect } from "node:util";
import type { AuthzEffect, AuthzRule } from "./types.ts";

/** Render a rejected value for an error message. Only used for values that are not secrets (policies, effects). */
export function describeValue(value: unknown): string {
    return inspect(value, { depth: 0, breakLength: Number.POSITIVE_INFINITY });
}

/**
 * Check that `value` is exactly `"allow"` or `"deny"`.
 *
 * Authorization compares against these two strings, and anything else used to be read as
 * "allow". A typo such as `"Deny"` therefore opened access instead of failing.
 *
 * @throws {TypeError} When the value is anything else
 */
export function assertAuthzEffect(factory: string, option: string, value: unknown): asserts value is AuthzEffect {
    if (value !== "allow" && value !== "deny") {
        throw new TypeError(`@connectum/auth: ${factory} ${option} must be "allow" or "deny"; got ${describeValue(value)}`);
    }
}

/**
 * Check the `defaultPolicy` and the `effect` of every rule of an authorization interceptor.
 *
 * @param factory - Name of the factory, for the message
 * @param defaultPolicy - The `defaultPolicy` option after its default was applied
 * @param rules - The `rules` option after its default was applied
 * @throws {TypeError} When the policy or an effect is not `"allow"` or `"deny"`
 */
export function assertAuthzPolicy(factory: string, defaultPolicy: unknown, rules: readonly AuthzRule[]): void {
    assertAuthzEffect(factory, "defaultPolicy", defaultPolicy);
    rules.forEach((rule, index) => {
        assertAuthzEffect(factory, `rules[${index}].effect (rule ${describeValue(rule?.name)})`, rule?.effect);
    });
}
