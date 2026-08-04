/**
 * File-emission layer for the scaffolding commands (`init`, `generate service`).
 *
 * Design contract (OpenSpec change cli-scaffolding, task 0.2):
 * - **Path-safe**: every relative path is validated; emission cannot escape the
 *   target directory (rejects absolute paths — POSIX and Windows — and `..`).
 * - **Refuse-to-clobber**: existing files are skipped unless `force` is set.
 * - **Deterministic**: files are emitted in sorted-path order.
 *
 * @module utils/emit
 */

import { existsSync, lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/** Matches Windows absolute paths: drive-letter (`C:\`, `C:/`) and UNC (`\\server\share`). */
const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]|^\\\\/;

/**
 * Assert that `relPath` is a safe relative path to emit under a target directory.
 *
 * Rejects empty paths, absolute paths (POSIX `/...` and Windows drive/UNC), and any
 * path containing a parent-traversal (`..`) segment — mirroring the path-safety used
 * by `@connectum/protoc-gen-catalog` so generated output cannot escape its root.
 *
 * @param relPath - Candidate relative path
 * @throws Error if the path is unsafe
 */
export function assertSafeRelativePath(relPath: string): void {
    if (relPath === "" || relPath.startsWith("/") || WINDOWS_ABSOLUTE.test(relPath) || relPath.split(/[/\\]/).includes("..")) {
        throw new Error(`Unsafe emit path: "${relPath}" (must be a relative path without "..")`);
    }
}

/**
 * Assert that no existing path component of `targetDir/relPath` is a symbolic link.
 *
 * {@link assertSafeRelativePath} is purely lexical, but `mkdirSync`/`writeFileSync`
 * **follow** symlinks — so an existing symlinked component (e.g. a `src` that points
 * elsewhere) would silently redirect writes outside `targetDir` even though the relative
 * path itself is clean. Every component is `lstat`ed and rejected if it is a link,
 * mirroring the symlink skip already used when reading the base tree.
 *
 * @param targetDir - Directory the relative path is resolved against
 * @param relPath - Validated relative path
 * @throws Error if any existing component (including `targetDir` itself) is a symlink
 */
function assertNoSymlinkComponent(targetDir: string, relPath: string): void {
    const check = (path: string): void => {
        let stat: ReturnType<typeof lstatSync>;
        try {
            stat = lstatSync(path);
        } catch {
            // Does not exist yet — mkdirSync will create a real directory.
            return;
        }
        if (stat.isSymbolicLink()) {
            throw new Error(`Unsafe emit path: "${relPath}" resolves through the symbolic link "${path}" (emission must stay inside the target directory)`);
        }
    };
    check(targetDir);
    let current = targetDir;
    for (const segment of relPath.split(/[/\\]/)) {
        current = current === "" ? segment : `${current}${sep}${segment}`;
        check(current);
    }
}

/**
 * Options for {@link emitFiles}.
 */
export interface EmitOptions {
    /** Overwrite existing files instead of skipping them (refuse-to-clobber is the default). */
    force?: boolean;
}

/**
 * Result of {@link emitFiles}.
 */
export interface EmitResult {
    /** Relative paths that were written. */
    written: string[];
    /** Relative paths skipped because a file already existed (and `force` was not set). */
    skipped: string[];
}

/**
 * Emit a set of files under `targetDir`.
 *
 * All relative paths are validated up front (a single unsafe path aborts before any
 * write). Files are emitted in sorted-path order; parent directories are created as
 * needed. By default an existing file is skipped (refuse-to-clobber); pass
 * `force: true` to overwrite.
 *
 * @param targetDir - Directory the relative paths are resolved against
 * @param files - Map of relative path -> file content
 * @param options - Emission options
 * @returns Which paths were written and which were skipped
 */
export function emitFiles(targetDir: string, files: ReadonlyMap<string, string>, options: EmitOptions = {}): EmitResult {
    const entries = [...files.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

    // Validate every path before writing anything, so an unsafe path never leaves a
    // partially-emitted tree behind. Symlink containment belongs in this preflight too:
    // checking it per-write would let the entries sorted ahead of the offending one land
    // on disk first, breaking the all-or-nothing guarantee.
    for (const [relPath] of entries) {
        assertSafeRelativePath(relPath);
        assertNoSymlinkComponent(targetDir, relPath);
    }

    const written: string[] = [];
    const skipped: string[] = [];

    for (const [relPath, content] of entries) {
        const absPath = join(targetDir, relPath);
        // Re-checked immediately before the write as well: preflight can only observe the
        // components that existed then, so this covers anything swapped in meanwhile.
        assertNoSymlinkComponent(targetDir, relPath);
        if (!options.force && existsSync(absPath)) {
            skipped.push(relPath);
            continue;
        }
        mkdirSync(dirname(absPath), { recursive: true });
        writeFileSync(absPath, content);
        written.push(relPath);
    }

    return { written, skipped };
}
