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
import { decodeJwt, UnsecuredJWT } from "jose";
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
 * Read a duration text the way jose reads `maxTokenAge`, in seconds, or `undefined` for a text jose
 * does not know ("1month"). The sign matters: a leading "-" and a trailing "ago" give a negative
 * value, and "0s" gives zero.
 *
 * jose does not export its parser, but its token builder reads an expiration text with the very same
 * one and stores `now + duration` in `exp`. So the text is put through the builder and the duration is
 * the distance of `exp` from the current second. If the second changes while the token is built the
 * distance is off by one, so the reading is repeated until the clock did not move.
 */
function readDurationSeconds(text: string): number | undefined {
    for (let attempt = 0; attempt < 5; attempt++) {
        const before = Math.floor(Date.now() / 1000);
        let exp: number | undefined;
        try {
            exp = decodeJwt(new UnsecuredJWT({}).setExpirationTime(text).encode()).exp;
        } catch {
            return undefined;
        }
        if (exp !== undefined && Math.floor(Date.now() / 1000) === before) {
            return exp - before;
        }
    }
    return undefined;
}

/**
 * Check a `maxTokenAge`: absent, a finite number of seconds greater than 0, or a duration text that
 * jose reads as a positive duration.
 *
 * `0` used to be skipped as falsy, which switched the age check off. A text that jose reads as zero or
 * negative ("0s", "-1h", "1h ago") makes the limit smaller than any age, so every token is rejected;
 * it is refused like the number 0.
 *
 * @throws {RangeError} When the number is not finite and greater than 0, the string is blank, unreadable, zero or negative
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
        const seconds = readDurationSeconds(value);
        if (seconds === undefined) {
            throw new RangeError(
                `@connectum/auth: ${factory} maxTokenAge must be a duration such as "2h", "7d" or "30 minutes" (seconds, minutes, hours, days, weeks, years); got ${describeValue(value)}`,
            );
        }
        if (seconds <= 0) {
            throw new RangeError(
                `@connectum/auth: ${factory} maxTokenAge must be a duration greater than 0, but jose reads ${describeValue(value)} as ${seconds} seconds (a leading "-" or a trailing "ago" makes it negative); got ${describeValue(value)}`,
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
    assertCallbackOptions("createAuthInterceptor", options, ["verifyCredentials"], ["extractCredentials"]);
}

/**
 * Check the callbacks the session authentication interceptor calls on every request.
 *
 * @throws {TypeError} When `verifySession` or `mapSession` is not a function, or `extractToken` is present and not a function
 */
export function assertSessionInterceptorOptions(options: unknown): void {
    assertCallbackOptions("createSessionAuthInterceptor", options, ["verifySession", "mapSession"], ["extractToken"]);
}

/**
 * Check that each required callback of `options` is a function and each optional one is a function when set.
 * A callback that is not callable fails inside the request path, where the caller sees a fixed
 * authentication error or `internal` and nothing that names the option.
 */
function assertCallbackOptions(factory: string, options: unknown, required: readonly string[], optional: readonly string[]): void {
    const record = isRecord(options) ? options : {};
    for (const name of required) {
        if (typeof record[name] !== "function") {
            throw new TypeError(`@connectum/auth: ${factory} ${name} must be a function; got ${describeKind(record[name])}`);
        }
    }
    for (const name of optional) {
        if (record[name] !== undefined && typeof record[name] !== "function") {
            throw new TypeError(`@connectum/auth: ${factory} ${name} must be a function when set; got ${describeKind(record[name])}`);
        }
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

/**
 * Check a `propagatedClaims` filter: absent, or an array of non-empty claim names.
 *
 * The filter keeps a claim when its name is in the list. A string used to be searched as text
 * (`"org_id".includes("id")`), so a mistaken value sent more than intended; a name that is not a
 * string never matches anything, so the claims header was dropped without a word.
 *
 * @throws {TypeError} When the value is present and is not an array of non-empty strings
 */
export function assertPropagatedClaims(factory: string, value: unknown): void {
    if (value === undefined) {
        return;
    }
    if (!Array.isArray(value) || ![...value].every((name) => typeof name === "string" && name.length > 0)) {
        throw new TypeError(
            `@connectum/auth: ${factory} propagatedClaims must be an array of non-empty claim names (omit the option to propagate every claim); got ${describeValue(value)}`,
        );
    }
}

/** Longest delay a Node.js timer keeps (2^31 - 1 ms); above it Node.js shortens the delay to 1 ms or refuses it, so the fetch would not wait or would not start. */
const MAX_TIMEOUT_MS = 2_147_483_647;

/** Option names `createRemoteJWKSet` of jose reads and this package passes on. */
const JWKS_OPTION_NAMES = ["cooldownDuration", "cacheMaxAge", "timeoutDuration"] as const;

/**
 * Check the `jwks` options of the JWT interceptor: absent, or an object of the three durations (in
 * milliseconds) that are handed to jose's remote key set.
 *
 * A present `jwks` needs `jwksUri` (the remote key set is the only place it is read), and an unknown
 * name is a typo that would otherwise change nothing. Ranges are those jose accepts, narrowed to the
 * ones that can work: a timeout of 0 aborts every fetch, one above the longest Node.js timer fails it, and an infinite cooldown would never refetch
 * for an unknown key.
 *
 * @throws {TypeError} When `jwks` is not an object, holds an unknown name or a non-number, or is set without `jwksUri`
 * @throws {RangeError} When a duration is outside its range
 */
export function assertJwksOptions(factory: string, jwks: unknown, jwksUri: unknown): void {
    if (jwks === undefined) {
        return;
    }
    if (!isRecord(jwks)) {
        throw new TypeError(`@connectum/auth: ${factory} jwks must be an object with ${JWKS_OPTION_NAMES.join(", ")}; got ${describeValue(jwks)}`);
    }
    if (!jwksUri) {
        throw new TypeError(`@connectum/auth: ${factory} jwks only applies to a remote key set; set jwksUri or drop jwks`);
    }
    for (const name of Object.keys(jwks)) {
        if (!(JWKS_OPTION_NAMES as readonly string[]).includes(name)) {
            throw new TypeError(`@connectum/auth: ${factory} jwks.${name} is not a known option; use ${JWKS_OPTION_NAMES.join(", ")}`);
        }
    }
    for (const name of JWKS_OPTION_NAMES) {
        const value = jwks[name];
        if (value === undefined) {
            continue;
        }
        if (typeof value !== "number" || Number.isNaN(value)) {
            throw new TypeError(`@connectum/auth: ${factory} jwks.${name} must be a number of milliseconds; got ${describeValue(value)}`);
        }
        if (name === "cooldownDuration" && !(Number.isFinite(value) && value >= 0)) {
            throw new RangeError(`@connectum/auth: ${factory} jwks.cooldownDuration must be a finite number of milliseconds, 0 or more; got ${describeValue(value)}`);
        }
        if (name === "cacheMaxAge" && !(value >= 0)) {
            throw new RangeError(
                `@connectum/auth: ${factory} jwks.cacheMaxAge must be a number of milliseconds, 0 or more (Infinity keeps keys until a missing key forces a refetch); got ${describeValue(value)}`,
            );
        }
        if (name === "timeoutDuration" && !(Number.isInteger(value) && value > 0 && value <= MAX_TIMEOUT_MS)) {
            throw new RangeError(
                `@connectum/auth: ${factory} jwks.timeoutDuration must be a whole number of milliseconds from 1 to ${MAX_TIMEOUT_MS} (a longer timer is cut to 1 ms or refused by Node.js); got ${describeValue(value)}`,
            );
        }
    }
}
