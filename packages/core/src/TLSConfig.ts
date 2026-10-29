/**
 * TLS configuration utilities
 *
 * @module TLSConfig
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path/posix";
import { cwd } from "node:process";
import { createSecureContext } from "node:tls";
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
    // In development, use ../../../keys relative to cwd
    const defaultPath = process.env.NODE_ENV === "production" ? rootPath : resolve(rootPath, "../../../keys");

    return env.get("TLS_DIR_PATH").default(defaultPath).asString();
}

/** One TLS file: its resolved path and the setting that supplied it. */
interface TLSFile {
    readonly file: string;
    readonly origin: string;
}

interface TLSFiles {
    readonly key: TLSFile;
    readonly cert: TLSFile;
}

/**
 * Work out which two files will be read and which setting each one comes from,
 * so that a failure can name both. The complete-pair rule is checked here,
 * before any file is read.
 */
function resolveTLSFiles(options: TLSOptions): TLSFiles {
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
            key: { file: resolve(keyPath), origin: "tls.keyPath" },
            cert: { file: resolve(certPath), origin: "tls.certPath" },
        };
    }

    // Otherwise use dirPath (or default TLS path)
    const resolvedDir = resolve(dirPath ?? getTLSPath());
    let origin: string;
    if (dirPath !== undefined) {
        origin = "tls.dirPath";
    } else if (env.get("TLS_DIR_PATH").asString() !== undefined) {
        origin = "TLS_DIR_PATH";
    } else {
        origin = "the default TLS directory; set tls.dirPath or TLS_DIR_PATH to change it";
    }
    return {
        key: { file: `${resolvedDir}/server.key`, origin },
        cert: { file: `${resolvedDir}/server.crt`, origin },
    };
}

/**
 * Read one file. A failure names the file, the setting that supplied its path
 * and its role; the file system error stays as `cause`, and its `code` and
 * `path` are copied so that callers can still tell a missing file from the
 * rest.
 */
function readTLSFile(source: TLSFile, role: "key" | "certificate"): Buffer {
    try {
        return readFileSync(source.file);
    } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        const { code, path } = cause as NodeJS.ErrnoException;
        throw Object.assign(new Error(`TLS ${role} file "${source.file}" (from ${source.origin}) could not be read: ${reason}`, { cause }), { code, path });
    }
}

function readTLSFiles(files: TLSFiles): { key: Buffer; cert: Buffer } {
    return {
        key: readTLSFile(files.key, "key"),
        cert: readTLSFile(files.cert, "certificate"),
    };
}

/**
 * Read TLS certificates from configuration
 *
 * Explicit keyPath and certPath are used when both are non-empty. When neither
 * is, both files come from dirPath or getTLSPath(). Exactly one of them is a
 * configuration error: falling back to the directory would start the server
 * with a certificate other than the one the operator named.
 *
 * The files are only read, not parsed; {@link loadTLSCertificates} also checks
 * that they hold a usable key and certificate.
 *
 * @param options - TLS options
 * @returns TLS key and cert buffers
 * @throws {Error} When only one of keyPath and certPath is non-empty; thrown before any file is read
 * @throws {Error} When a file cannot be read; the message names the file and the setting its path came from
 */
export function readTLSCertificates(options: TLSOptions = {}): {
    key: Buffer;
    cert: Buffer;
} {
    return readTLSFiles(resolveTLSFiles(options));
}

/**
 * Read the TLS key and certificate and check that the server can use them.
 *
 * OpenSSL's own text for a file that is not PEM names neither the file nor the
 * setting that pointed to it, so each file is parsed on its own first and the
 * pair after that; every failure names the file(s) and where the path came from.
 *
 * @param options - TLS options
 * @param secureOptions - `passphrase` of an encrypted key, as the server receives it from `http2Options`; without it an encrypted key would be reported as unusable
 * @returns TLS key and cert buffers
 * @internal
 * @throws {Error} Everything {@link readTLSCertificates} throws, and when the key or the certificate cannot be parsed or the two do not match
 */
export function loadTLSCertificates(
    options: TLSOptions = {},
    secureOptions: { passphrase?: string | undefined } = {},
): {
    key: Buffer;
    cert: Buffer;
} {
    const files = resolveTLSFiles(options);
    const certificates = readTLSFiles(files);

    const describe = (source: TLSFile, role: "key" | "certificate"): string => `TLS ${role} file "${source.file}" (from ${source.origin})`;
    const { passphrase } = secureOptions;
    const check = (description: string, material: { key?: Buffer; cert?: Buffer }): void => {
        try {
            createSecureContext(passphrase === undefined ? material : { ...material, passphrase });
        } catch (cause) {
            const reason = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
            throw new Error(`${description}: ${reason}`, { cause });
        }
    };

    check(`${describe(files.key, "key")} is not a usable PEM private key`, { key: certificates.key });
    check(`${describe(files.cert, "certificate")} is not a usable PEM certificate`, { cert: certificates.cert });
    check(`${describe(files.key, "key")} does not match ${describe(files.cert, "certificate")}`, certificates);

    return certificates;
}

/**
 * Exported for backward compatibility
 */
export const tlsPath = getTLSPath();
