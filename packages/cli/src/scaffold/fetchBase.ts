/**
 * Base-project fetcher for `connectum init`.
 *
 * Per OpenSpec change cli-scaffolding (D-13, task 0.3), the inert base project is
 * NOT vendored inside the CLI — it is fetched live from the source-of-truth example
 * `Connectum-Framework/examples/getting-started` via a degit-style clone (`tiged`),
 * so there is a single source of truth and no drift-prone duplicate.
 *
 * The clone function is injectable so the composition/transform logic can be unit
 * tested against a local fixture without any network access.
 *
 * NOTE: the `examples` repository does not yet publish release tags, so the default
 * ref is `main`. When examples begins tagging releases, pin `DEFAULT_BASE_REF` (per
 * CLI release) to the matching tag so a broken `main` cannot break every `init`.
 *
 * @module scaffold/fetchBase
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Source-of-truth base repo + subdirectory (without the `#ref` suffix). */
export const BASE_SOURCE = "Connectum-Framework/examples/getting-started";

/** Default git ref to fetch (see module note: examples has no tags yet). */
export const DEFAULT_BASE_REF = "main";

/**
 * Clones `source` (a tiged-style `owner/repo/subdir#ref` spec) into `dest`.
 * Extracted as a type so it can be replaced in tests with a local-copy stub.
 */
export type CloneFn = (source: string, dest: string) => Promise<void>;

/** Default {@link CloneFn} backed by `tiged`. */
export const tigedClone: CloneFn = async (source, dest) => {
    // Imported lazily so unit tests that inject a stub never load tiged (and never
    // touch the network).
    const { default: tiged } = await import("tiged");
    const emitter = tiged(source, { cache: false, force: true, verbose: false });
    await emitter.clone(dest);
};

/**
 * Fetch the base project into `dest`.
 *
 * @throws Error with a clear message if the clone fails (e.g. network / GitHub
 *   unreachable) — never a raw crash.
 */
export async function fetchBase(dest: string, options: { ref?: string | undefined; clone?: CloneFn | undefined } = {}): Promise<void> {
    const ref = options.ref ?? DEFAULT_BASE_REF;
    const clone = options.clone ?? tigedClone;
    const source = `${BASE_SOURCE}#${ref}`;
    try {
        await clone(source, dest);
    } catch (cause) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        throw new Error(`connectum init: failed to fetch the base project from "${source}". Check network / GitHub availability and try again. Cause: ${reason}`, { cause });
    }
}

/**
 * Recursively read a directory tree into a `Map<relativePath, content>` with
 * POSIX-style forward-slash keys (so transforms are platform-independent).
 *
 * @param root - Directory to read
 * @returns Map of relative path -> UTF-8 content
 */
export function readTree(root: string): Map<string, string> {
    const files = new Map<string, string>();
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir)) {
            const abs = join(dir, entry);
            const stat = lstatSync(abs);
            // Skip symlinks: getting-started's `.pnpmfile.cjs` is a symlink into the
            // examples-monorepo root (broken in a subdir clone), and monorepo symlinks
            // are dropped from a standalone project anyway.
            if (stat.isSymbolicLink()) {
                continue;
            }
            if (stat.isDirectory()) {
                walk(abs);
                continue;
            }
            const rel = relative(root, abs).split(/[\\/]/).join("/");
            files.set(rel, readFileSync(abs, "utf8"));
        }
    };
    walk(root);
    return files;
}
