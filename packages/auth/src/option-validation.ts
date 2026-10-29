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

/**
 * Check an expected `issuer` or `audience`: absent, one non-empty string, or an array of non-empty strings.
 *
 * An empty string used to switch the check off, so a token with any issuer or audience was
 * accepted when the value came from `process.env.X ?? ""`. An empty array is left alone: it
 * matches no token, which is the fail-closed reading.
 *
 * @throws {TypeError} When the value is present and is anything else
 */
export function assertExpectedClaim(factory: string, option: "issuer" | "audience", value: unknown): void {
    if (value === undefined) {
        return;
    }
    const entries: unknown[] = Array.isArray(value) ? value : [value];
    if (!entries.every((entry) => typeof entry === "string" && entry.length > 0)) {
        throw new TypeError(
            `@connectum/auth: ${factory} ${option} must be a non-empty string or an array of non-empty strings (omit the option to skip the check); got ${describeValue(value)}`,
        );
    }
}

/**
 * Check a `maxTokenAge`: absent, a finite number of seconds greater than 0, or a non-empty duration string.
 *
 * `0` used to be skipped as falsy, which switched the age check off.
 *
 * @throws {RangeError} When the number is not finite and greater than 0, or the string is blank
 * @throws {TypeError} When the value is neither a number nor a string
 */
export function assertMaxTokenAge(factory: string, value: unknown): void {
    if (value === undefined) {
        return;
    }
    if (typeof value === "number") {
        if (!Number.isFinite(value) || value <= 0) {
            throw new RangeError(
                `@connectum/auth: ${factory} maxTokenAge must be a finite number of seconds greater than 0 (omit the option to skip the check); got ${describeValue(value)}`,
            );
        }
        return;
    }
    if (typeof value === "string") {
        if (value.trim().length === 0) {
            throw new RangeError(`@connectum/auth: ${factory} maxTokenAge must not be blank (omit the option to skip the check); got ${describeValue(value)}`);
        }
        return;
    }
    throw new TypeError(`@connectum/auth: ${factory} maxTokenAge must be a number of seconds or a duration string such as "2h"; got ${describeValue(value)}`);
}
