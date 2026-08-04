/**
 * Base-project fetcher for `connectum init`.
 *
 * Per OpenSpec change cli-scaffolding (D-13, task 0.3), the inert base project is
 * NOT vendored inside the CLI — it is fetched live from the source-of-truth example
 * `Connectum-Framework/examples/getting-started` via a degit-style download (`giget`),
 * so there is a single source of truth and no drift-prone duplicate.
 *
 * The clone function is injectable so the composition/transform logic can be unit
 * tested against a local fixture without any network access.
 *
 * The default ref is a **tag, not `main`**. A published CLI is immutable but its base
 * is not: because the module fragments transform the fetched text (see
 * `applyAuthProtoAnnotations`, which matches the sample rpc and fails loudly if it is
 * gone), an edit on `examples/main` would otherwise break `init` for every already-
 * published CLI version, retroactively. Pinning makes each CLI release reproducible.
 *
 * That does not retire `examples` as the place regressions surface — it moves the
 * discovery into CI: the `cli-scaffold-matrix` workflow additionally scaffolds with
 * `--ref main`, so drift between the pinned base and the live example fails a
 * connectum PR instead of a user's `init`. Bump this constant deliberately, as part
 * of a CLI release, once that cell is green on a new example tag.
 *
 * @module scaffold/fetchBase
 */

import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

/** Source-of-truth base repo + subdirectory (without the `#ref` suffix). */
export const BASE_SOURCE = "Connectum-Framework/examples/getting-started";

/**
 * Default git ref to fetch: a pinned `examples` release tag, never a moving branch
 * (see the module note). Override per invocation with `connectum init --ref <ref>`.
 */
export const DEFAULT_BASE_REF = "v1.3.0";

/**
 * Downloads `source` (a `gh:owner/repo/subdir#ref` spec) into `dest`.
 * Extracted as a type so it can be replaced in tests with a local-copy stub.
 */
export type CloneFn = (source: string, dest: string) => Promise<void>;

/**
 * Default {@link CloneFn}, backed by `giget`.
 *
 * `giget` is preferred over the older `degit`/`tiged` line because it has **no
 * dependencies at all**: those pull `tar` transitively, and the `tar` releases they
 * pin carry a decompression denial-of-service and an arbitrary-file-overwrite
 * advisory. A scaffolder exists to download and unpack a remote archive, so its
 * extraction path is exactly where that matters.
 */
export const gigetClone: CloneFn = async (source, dest) => {
    // Imported lazily so unit tests that inject a stub never load giget (and never
    // touch the network).
    const { downloadTemplate } = await import("giget");
    await downloadTemplate(source, { dir: dest, force: true });
};

/**
 * Fetch the base project into `dest`.
 *
 * @throws Error with a clear message if the clone fails (e.g. network / GitHub
 *   unreachable) — never a raw crash.
 */
export async function fetchBase(dest: string, options: { ref?: string | undefined; clone?: CloneFn | undefined } = {}): Promise<void> {
    const ref = options.ref ?? DEFAULT_BASE_REF;
    const clone = options.clone ?? gigetClone;
    // `gh:` is giget's provider prefix; without it the spec is read as a local path.
    const source = `gh:${BASE_SOURCE}#${ref}`;
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
