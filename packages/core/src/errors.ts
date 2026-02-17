/**
 * Sanitizable error protocol
 *
 * Interface for errors that carry server-side details while providing
 * a safe client-facing message. ErrorHandler interceptor recognizes
 * this interface and sanitizes automatically.
 *
 * @module errors
 */

/**
 * Sanitizable error interface.
 *
 * Errors implementing this protocol carry rich server-side details
 * but expose only a safe message to clients.
 */
export interface SanitizableError {
    readonly clientMessage: string;
    readonly serverDetails: Readonly<Record<string, unknown>>;
}

/**
 * Type guard for SanitizableError.
 *
 * Checks if the value is an object with clientMessage (string) and
 * serverDetails (non-null object) properties, plus a numeric code.
 */
export function isSanitizableError(err: unknown): err is Error & SanitizableError & { code: number } {
    if (err == null || typeof err !== "object") return false;
    const candidate = err as Record<string, unknown>;
    return typeof candidate.clientMessage === "string" && typeof candidate.serverDetails === "object" && candidate.serverDetails !== null && typeof candidate.code === "number";
}
