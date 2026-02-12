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
 * @param options - TLS options
 * @returns TLS key and cert buffers
 */
export function readTLSCertificates(options: TLSOptions = {}): {
    key: Buffer;
    cert: Buffer;
} {
    const { keyPath, certPath, dirPath } = options;

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
