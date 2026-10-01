/**
 * Build the workspace and `pnpm pack` every publishable `@connectum/*` package.
 *
 * Shared by the checks that must see the framework exactly as a consumer receives it
 * from npm: `pnpm pack` rewrites `workspace:` and `catalog:` specifiers into the ranges
 * that get published, so a tarball's manifest is the published manifest, while the
 * workspace's own `package.json` is not.
 *
 * The package set is read from `packages/*` (every manifest without `private: true`),
 * so a new package is packed without anyone remembering to list it here.
 *
 * @module scripts/lib/pack-workspace
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Read the publishable packages of the workspace.
 *
 * @param {string} repoRoot - the connectum repository root
 * @returns {{ name: string, dir: string, version: string }[]}
 */
export function listPublishablePackages(repoRoot) {
    const packagesDir = join(repoRoot, "packages");
    const out = [];
    for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(packagesDir, entry.name);
        let manifest;
        try {
            manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
        } catch {
            continue;
        }
        if (manifest.private === true) continue;
        out.push({ name: manifest.name, dir, version: manifest.version });
    }
    return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

/**
 * Build the workspace, then pack every publishable package into `dest`.
 *
 * @param {object} options
 * @param {string} options.repoRoot - the connectum repository root
 * @param {string} options.dest - directory that receives the tarballs (created if missing)
 * @param {boolean} [options.build=true] - run `pnpm build` first; pass `false` when dist/ is known to be current
 * @returns {Map<string, string>} package name -> absolute tarball path
 */
export function packWorkspace({ repoRoot, dest, build = true }) {
    mkdirSync(dest, { recursive: true });
    // Tarballs are told apart by what each pack call adds; a leftover from an earlier
    // run with the same file name would be overwritten and look like "nothing added".
    if (readdirSync(dest).length > 0) {
        throw new Error(`pack-workspace: ${dest} must be empty`);
    }
    if (build) {
        execFileSync("pnpm", ["build"], { cwd: repoRoot, stdio: "inherit" });
    }
    const tarballs = new Map();
    for (const pkg of listPublishablePackages(repoRoot)) {
        const before = new Set(readdirSync(dest));
        execFileSync("pnpm", ["pack", "--pack-destination", dest], { cwd: pkg.dir, stdio: "pipe" });
        // The file name is pnpm's to choose; take whatever this pack call added rather
        // than predicting it, so a package whose name prefixes another's cannot collide.
        const added = readdirSync(dest).filter((f) => !before.has(f) && f.endsWith(".tgz"));
        if (added.length !== 1) {
            throw new Error(`pack-workspace: expected one new tarball for ${pkg.name}, got ${JSON.stringify(added)}`);
        }
        tarballs.set(pkg.name, join(dest, added[0]));
    }
    return tarballs;
}

/**
 * Read the manifest packed inside a tarball — what a consumer's installed copy must equal.
 *
 * @param {string} tarball - absolute path to a `pnpm pack` tarball
 * @returns {Record<string, unknown>}
 */
export function readPackedManifest(tarball) {
    return JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" }));
}
