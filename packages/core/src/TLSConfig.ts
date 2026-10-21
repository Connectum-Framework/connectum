/**
 * TLS configuration utilities
 *
 * @module TLSConfig
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path/posix";
import { cwd } from "node:process";
import env from "env-var";
import type { TLSOptions } from "./types.ts";

/**
 * Get TLS directory path
 *
 * Resolves TLS directory from environment variable or default location.
 *
 * @returns TLS directory path
 */
export function getTLSPath(): string {
    const rootPath = cwd();

    // In production, use current directory
    // In development, use ../../keys relative to cwd
    const defaultPath = process.env.NODE_ENV === "production" ? rootPath : resolve(rootPath, "../../../keys");

    return env.get("TLS_DIR_PATH").default(defaultPath).asString();
}

/**
 * Read TLS certificates from configuration
 *
 * Explicit keyPath and certPath are used when both are non-empty. When neither
 * is, both files come from dirPath or getTLSPath(). Exactly one of them is a
 * configuration error: falling back to the directory would start the server
 * with a certificate other than the one the operator named.
 *
 * @param options - TLS options
 * @returns TLS key and cert buffers
 * @throws {Error} When only one of keyPath and certPath is non-empty; thrown before any file is read
 */
export function readTLSCertificates(options: TLSOptions = {}): {
    key: Buffer;
    cert: Buffer;
} {
    const { keyPath, certPath, dirPath } = options;

    if (keyPath && !certPath) {
        throw new Error('TLS configuration is incomplete: "keyPath" is set but "certPath" is not. Set both, or neither to read server.key and server.crt from the directory.');
    }
    if (certPath && !keyPath) {
        throw new Error('TLS configuration is incomplete: "certPath" is set but "keyPath" is not. Set both, or neither to read server.key and server.crt from the directory.');
    }

    // If explicit paths provided, use them (resolve to absolute paths)
    if (keyPath && certPath) {
        return {
            key: readFileSync(resolve(keyPath)),
            cert: readFileSync(resolve(certPath)),
        };
    }

    // Otherwise use dirPath (or default TLS path)
    const tlsDir = dirPath ?? getTLSPath();
    const resolvedDir = resolve(tlsDir);

    return {
        key: readFileSync(`${resolvedDir}/server.key`),
        cert: readFileSync(`${resolvedDir}/server.crt`),
    };
}

/**
 * Exported for backward compatibility
 */
export const tlsPath = getTLSPath();
