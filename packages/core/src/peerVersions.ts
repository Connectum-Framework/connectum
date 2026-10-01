/**
 * Runtime check that the protobuf / Connect copies `@connectum/core` actually loaded
 * satisfy its peer ranges.
 *
 * Package managers do not all stop an out-of-range peer: npm refuses the install, but
 * pnpm only warns, Bun stays silent when another in-range copy exists anywhere in the
 * tree, and Yarn leaves peers to the application. A too-old `@bufbuild/protobuf` or
 * Connect then surfaces much later as mismatched generated types or a broken runtime.
 * `createServer()` runs this check so the mismatch fails at startup, naming the package,
 * the version that was loaded, the required range and the fix.
 *
 * How the loaded version is found: `import.meta.resolve(<library>)` from this module
 * returns the very file a static `import` in this module loads — the copy core really
 * uses, not "some copy in node_modules". The nearest `package.json` above that file
 * whose `name` is the library holds its version. Libraries do not export
 * `./package.json` (Node rejects `<library>/package.json` with
 * ERR_PACKAGE_PATH_NOT_EXPORTED), which is why the manifest is located on disk instead.
 *
 * The required ranges are read from core's own `package.json` (`peerDependencies`), so
 * the published manifest stays the single source of truth for the floors.
 *
 * Undeterminable is not a failure. When core is bundled (the nearest manifest above this
 * module is not `@connectum/core`), when the runtime has no `import.meta.resolve`, or
 * when a manifest cannot be read, the check is skipped: a bundle has inlined whichever
 * copy the bundler picked, and a guess about it would only produce false failures.
 *
 * @module peerVersions
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The peer libraries whose loaded version is checked. */
export const CHECKED_PEERS = ["@bufbuild/protobuf", "@connectrpc/connect", "@connectrpc/connect-node"] as const;

/** One loaded library outside the range `@connectum/core` declares for it. */
export interface PeerVersionProblem {
    /** Package name, e.g. `@bufbuild/protobuf`. */
    readonly packageName: string;
    /** Version of the copy core loaded. */
    readonly loadedVersion: string;
    /** Range from core's `peerDependencies`, e.g. `^2.16.0`. */
    readonly requiredRange: string;
    /** Directory of the loaded copy, so the reader can see which copy it was. */
    readonly loadedFrom: string;
}

/** Outcome of a check: either checked (with problems, possibly none) or skipped with a reason. */
export type PeerVersionReport = { readonly status: "checked"; readonly problems: readonly PeerVersionProblem[] } | { readonly status: "skipped"; readonly reason: string };

/** Thrown by `createServer()` when a loaded peer library is outside core's range. */
export class PeerDependencyVersionError extends Error {
    override readonly name = "PeerDependencyVersionError";
    readonly problems: readonly PeerVersionProblem[];

    constructor(problems: readonly PeerVersionProblem[]) {
        super(formatProblems(problems));
        this.problems = problems;
        Object.setPrototypeOf(this, PeerDependencyVersionError.prototype);
    }
}

function formatProblems(problems: readonly PeerVersionProblem[]): string {
    const lines = problems.map((p) => `  - ${p.packageName}: loaded ${p.loadedVersion} (from ${p.loadedFrom}), @connectum/core requires ${p.requiredRange}`);
    const installs = problems.map((p) => `${p.packageName}@"${p.requiredRange}"`).join(" ");
    return [
        "@connectum/core loaded peer libraries outside its supported range:",
        ...lines,
        "Generated code and the framework must share one in-range copy of each library; an older copy breaks generated types and Connect at runtime.",
        `Fix: raise your pins to the required ranges (npm install ${installs}, or the pnpm / bun / yarn equivalent), or force one in-range version with "overrides" (npm, Bun), pnpm "overrides" or Yarn "resolutions", then reinstall.`,
    ].join("\n");
}

/** Nearest `package.json` at or above `startDir` that has a `name`; `undefined` if none or unreadable. */
function nearestNamedManifest(startDir: string): { dir: string; manifest: Record<string, unknown> } | undefined {
    let dir = startDir;
    for (;;) {
        let manifest: Record<string, unknown> | undefined;
        try {
            manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
        } catch {
            manifest = undefined;
        }
        // A nested `{"type":"module"}` marker (dist/esm/package.json) has no name: keep walking.
        if (manifest && typeof manifest.name === "string") return { dir, manifest };
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/** `[major, minor, patch, isPrerelease]`, or `undefined` for anything that is not plain semver. */
function parseVersion(version: string): [number, number, number, boolean] | undefined {
    const match = /^(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.exec(version);
    if (!match) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3]), match[4] !== undefined];
}

/**
 * Whether `version` satisfies `range`. Only the caret form `^X.Y.Z` with X >= 1 — the
 * form core publishes — is understood; any other range returns `undefined` (unknown),
 * and the caller skips that library rather than guess.
 */
export function satisfiesCaret(version: string, range: string): boolean | undefined {
    const floor = range.startsWith("^") ? parseVersion(range.slice(1)) : undefined;
    const loaded = parseVersion(version);
    if (!floor || floor[3] || floor[0] === 0 || !loaded) return undefined;
    // A prerelease never satisfies a caret range without a prerelease of its own.
    if (loaded[3]) return false;
    if (loaded[0] !== floor[0]) return false;
    if (loaded[1] !== floor[1]) return loaded[1] > floor[1];
    return loaded[2] >= floor[2];
}

/**
 * Check the loaded copies against core's peer ranges.
 *
 * @param options.selfUrl - URL of the module doing the check (`import.meta.url`); its
 *   nearest named manifest must be `@connectum/core`, otherwise core is bundled and the
 *   check is skipped
 * @param options.resolve - resolves a bare specifier exactly as the checking module's
 *   own imports do (`import.meta.resolve`); `undefined` when the runtime has none
 */
export function checkPeerVersions(options: { selfUrl: string | undefined; resolve: ((specifier: string) => string) | undefined }): PeerVersionReport {
    const { selfUrl, resolve } = options;
    if (typeof selfUrl !== "string" || !selfUrl.startsWith("file:")) {
        return { status: "skipped", reason: "the module URL is not a file URL (bundled or non-file runtime)" };
    }
    if (typeof resolve !== "function") {
        return { status: "skipped", reason: "import.meta.resolve is not available in this runtime" };
    }
    const own = nearestNamedManifest(dirname(fileURLToPath(selfUrl)));
    if (own?.manifest.name !== "@connectum/core") {
        return { status: "skipped", reason: "@connectum/core is bundled: its own package.json is not next to the running code" };
    }
    const peers = (own.manifest.peerDependencies ?? {}) as Record<string, unknown>;

    const problems: PeerVersionProblem[] = [];
    for (const packageName of CHECKED_PEERS) {
        const requiredRange = peers[packageName];
        if (typeof requiredRange !== "string") continue;
        let entryUrl: string;
        try {
            entryUrl = resolve(packageName);
        } catch {
            // Not resolvable from core: the import itself would have failed earlier.
            continue;
        }
        if (!entryUrl.startsWith("file:")) continue;
        const found = nearestNamedManifest(dirname(fileURLToPath(entryUrl)));
        if (!found || found.manifest.name !== packageName || typeof found.manifest.version !== "string") continue;
        const ok = satisfiesCaret(found.manifest.version, requiredRange);
        if (ok === false) {
            problems.push({ packageName, loadedVersion: found.manifest.version, requiredRange, loadedFrom: found.dir });
        }
    }
    return { status: "checked", problems };
}

let cached: PeerVersionReport | undefined;

/**
 * Check this process's loaded copies once and throw {@link PeerDependencyVersionError}
 * when any is outside core's peer ranges. The result is cached: the loaded modules cannot
 * change for the life of the process.
 */
export function assertPeerVersions(): void {
    if (cached === undefined) {
        const resolve = typeof import.meta.resolve === "function" ? (specifier: string) => import.meta.resolve(specifier) : undefined;
        cached = checkPeerVersions({ selfUrl: import.meta.url, resolve });
    }
    if (cached.status === "checked" && cached.problems.length > 0) {
        throw new PeerDependencyVersionError(cached.problems);
    }
}
