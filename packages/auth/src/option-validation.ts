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
import { SignJWT } from "jose";
import type { AuthzEffect, AuthzRule } from "./types.ts";

/** Render a rejected value for an error message. Only used for values that are not secrets (policies, effects). */
export function describeValue(value: unknown): string {
    return typeof value === "string" ? JSON.stringify(value) : inspect(value, { depth: 0, breakLength: Number.POSITIVE_INFINITY });
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
        // jose reads the text with its own parser on every request and throws for one it does not
        // know ("1month"), which rejects every token as "Authentication failed". Its token builder
        // reads an expiration text with the same parser, so asking it here keeps the two in step.
        try {
            new SignJWT({}).setExpirationTime(value);
        } catch {
            throw new RangeError(
                `@connectum/auth: ${factory} maxTokenAge must be a duration such as "2h", "7d" or "30 minutes" (seconds, minutes, hours, days, weeks, years); got ${describeValue(value)}`,
            );
        }
        return;
    }
    throw new TypeError(`@connectum/auth: ${factory} maxTokenAge must be a number of seconds or a duration string such as "2h"; got ${describeValue(value)}`);
}

/** `*`, `Service/*` or `Service/Method`, where neither part is empty or holds `/`, `*` or whitespace. */
const SUPPORTED_PATTERN = /^(?:\*|[^\s/*]+\/(?:\*|[^\s/*]+))$/;

/**
 * Check that `patterns` is an array of method patterns this package can match.
 *
 * `matchesMethodPattern` compares only `*`, `Service/*` and the exact `Service/Method`. Any
 * other string (`Service/Write*`, a wildcard inside the service name, a bare service name, a
 * leading slash) matches nothing, so a `deny` rule or a `skipMethods` entry written that way
 * would be accepted and stay silently inactive. It is refused here instead.
 *
 * @param option - Where the patterns came from, for the message (for example `skipMethods`)
 * @param patterns - The value of the option
 * @throws {TypeError} When `patterns` is not an array of strings, or holds an unsupported pattern
 */
export function assertMethodPatterns(option: string, patterns: unknown): void {
    if (!Array.isArray(patterns)) {
        throw new TypeError(`@connectum/auth: ${option} must be an array of method patterns; got ${describeValue(patterns)}`);
    }
    for (const pattern of patterns) {
        if (typeof pattern !== "string" || !SUPPORTED_PATTERN.test(pattern)) {
            throw new TypeError(
                `@connectum/auth: ${option} contains the unsupported method pattern ${describeValue(pattern)}; ` +
                    `use "*", "Service/*" or "Service/Method" (partial wildcards such as "Service/Write*" never match)`,
            );
        }
    }
}

/**
 * Check the `methods` of every authorization rule.
 *
 * @param factory - Name of the factory, for the message
 * @param rules - The `rules` option after its default was applied
 * @throws {TypeError} When a rule's `methods` is not an array of supported patterns
 */
export function assertRuleMethods(factory: string, rules: readonly AuthzRule[]): void {
    rules.forEach((rule, index) => {
        assertMethodPatterns(`${factory} rules[${index}].methods (rule ${describeValue(rule?.name)})`, rule?.methods);
    });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Name the kind of a value without printing it, for options that may hold a secret. */
export function describeKind(value: unknown): string {
    if (value === null) return "null";
    if (Array.isArray(value)) return "an array";
    if (typeof value === "string") return value.length === 0 ? "an empty string" : "a string";
    return typeof value === "undefined" ? "undefined" : `a ${typeof value}`;
}

/**
 * Check the options a gateway interceptor cannot work without.
 *
 * `expectedValues` usually holds a shared secret, often read from an environment variable that
 * may be unset (`[process.env.GATEWAY_SECRET]` gives `[undefined]`). Such an interceptor used to
 * be created and then failed every request with `internal`. Messages name the kind of a bad
 * value, never the value, because it may be a secret.
 *
 * @throws {TypeError} When `headerMapping` or `trustSource` is not an object, or
 *   `trustSource.expectedValues` is not an array of non-empty strings
 */
export function assertGatewayOptions(options: unknown): void {
    const factory = "createGatewayAuthInterceptor";
    const { headerMapping, trustSource } = (isRecord(options) ? options : {}) as { headerMapping?: unknown; trustSource?: unknown };
    if (!isRecord(headerMapping)) {
        throw new TypeError(`@connectum/auth: ${factory} headerMapping must be an object that maps at least "subject" to a header name; got ${describeKind(headerMapping)}`);
    }
    if (!isRecord(trustSource)) {
        throw new TypeError(`@connectum/auth: ${factory} trustSource must be an object with header and expectedValues; got ${describeKind(trustSource)}`);
    }
    // The trust header name is checked by the header-name check that runs after this one.
    const { expectedValues } = trustSource;
    if (!Array.isArray(expectedValues)) {
        throw new TypeError(`@connectum/auth: ${factory} trustSource.expectedValues must be an array of non-empty strings; got ${describeKind(expectedValues)}`);
    }
    expectedValues.forEach((value, index) => {
        if (typeof value !== "string" || value.length === 0) {
            throw new TypeError(
                `@connectum/auth: ${factory} trustSource.expectedValues[${index}] must be a non-empty string (an unset environment variable reads as undefined); got ${describeKind(value)}`,
            );
        }
    });
}

/**
 * Check the callbacks the generic authentication interceptor calls on every request.
 *
 * @throws {TypeError} When `verifyCredentials` is not a function, or `extractCredentials` is present and not a function
 */
export function assertAuthInterceptorOptions(options: unknown): void {
    const { verifyCredentials, extractCredentials } = (isRecord(options) ? options : {}) as { verifyCredentials?: unknown; extractCredentials?: unknown };
    if (typeof verifyCredentials !== "function") {
        throw new TypeError(`@connectum/auth: createAuthInterceptor verifyCredentials must be a function; got ${describeKind(verifyCredentials)}`);
    }
    if (extractCredentials !== undefined && typeof extractCredentials !== "function") {
        throw new TypeError(`@connectum/auth: createAuthInterceptor extractCredentials must be a function when set; got ${describeKind(extractCredentials)}`);
    }
}

/**
 * Check the credential a client interceptor will send: a non-empty string, or (for a token) a function that returns one.
 *
 * `Authorization: Bearer ${undefined}` is the text `Bearer undefined`, which the server rejects as
 * an invalid credential far from the missing configuration, so a value that is not a usable
 * credential is refused where it is configured. Messages name the kind of a bad value, never the
 * value, because it is a secret.
 *
 * @throws {TypeError} When the value is not a non-empty string (or a function, when `allowFunction` is set)
 */
export function assertClientCredential(factory: string, option: string, value: unknown, allowFunction = false): void {
    if (typeof value === "string" && value.length > 0) {
        return;
    }
    if (allowFunction && typeof value === "function") {
        return;
    }
    throw new TypeError(`@connectum/auth: ${factory} ${option} must be a non-empty string${allowFunction ? " or a function that returns one" : ""}; got ${describeKind(value)}`);
}
