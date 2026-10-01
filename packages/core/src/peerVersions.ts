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
 * Lockstep is checked too: `@connectrpc/connect-node` declares ONE exact
 * `@connectrpc/connect` version as its peer, and a pair out of step is not reported at
 * install time by Bun or Yarn. The `connect` that connect-node itself loads is resolved
 * from connect-node's own location and must be that exact version — and the same copy
 * core loads.
 *
 * Undeterminable is not a failure. When core is bundled (the nearest manifest above this
 * module is not `@connectum/core`), when the runtime has no `import.meta.resolve`, or
 * when a manifest cannot be read, the check is skipped: a bundle has inlined whichever
 * copy the bundler picked, and a guess about it would only produce false failures.
 *
 * @module peerVersions
 */

import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The peer libraries whose loaded version is checked. */
export const CHECKED_PEERS = ["@bufbuild/protobuf", "@connectrpc/connect", "@connectrpc/connect-node"] as const;

/**
 * One loaded library that does not match what a package requires of it.
 *
 * `kind: "range"` — the loaded version is outside `requiredRange`, declared by
 * `requiredBy` (`@connectum/core`, or `@connectrpc/connect-node` for its own `connect`).
 * `kind: "split"` — `@connectrpc/connect-node` loads a different `@connectrpc/connect`
 * copy (`loadedFrom`) than `@connectum/core` does (`otherCopy`).
 */
export interface PeerVersionProblem {
    readonly kind: "range" | "split";
    /** Package name, e.g. `@bufbuild/protobuf`. */
    readonly packageName: string;
    /** Version of the copy that was loaded. */
    readonly loadedVersion: string;
    /** Range the requiring package declares, e.g. `^2.16.0`, or `2.2.0` for connect-node's exact peer. */
    readonly requiredRange: string;
    /** The package whose requirement is not met, with its version when known. */
    readonly requiredBy: string;
    /** Directory of the loaded copy, so the reader can see which copy it was. */
    readonly loadedFrom: string;
    /** `kind: "split"` only: directory of the copy `@connectum/core` loads. */
    readonly otherCopy?: string;
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
    const lines = problems.map((p) =>
        p.kind === "split"
            ? `  - ${p.packageName}: ${p.requiredBy} loads ${p.loadedVersion} from ${p.loadedFrom}, a different copy than @connectum/core loads (${p.otherCopy})`
            : `  - ${p.packageName}: loaded ${p.loadedVersion} (from ${p.loadedFrom}), ${p.requiredBy} requires ${p.requiredRange}`,
    );
    // Only core's own ranges go into the install command: connect-node's exact connect
    // peer can contradict them (connect-node 2.1.2 wants connect 2.1.2, core wants
    // ^2.2.0), and the lockstep line below says what to do instead.
    const installs = [...new Set(problems.filter((p) => p.kind === "range" && p.requiredBy === "@connectum/core").map((p) => `${p.packageName}@"${p.requiredRange}"`))].join(" ");
    const lockstep = problems.some((p) => p.requiredBy.startsWith("@connectrpc/connect-node") || p.kind === "split");
    return [
        "@connectum/core loaded peer libraries outside its supported range:",
        ...lines,
        "Generated code and the framework must share one in-range copy of each library; an older copy breaks generated types and Connect at runtime.",
        ...(lockstep ? ["@connectrpc/connect-node works only with the exact @connectrpc/connect version it declares: keep both on the same version, with a single copy."] : []),
        `Fix: raise your pins to the required ranges${installs ? ` (npm install ${installs}, or the pnpm / bun / yarn equivalent)` : ""}, or force one in-range version with "overrides" (npm, Bun), pnpm "overrides" or Yarn "resolutions", then reinstall.`,
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
 * Whether `version` satisfies a peer range as packages publish it: an exact `X.Y.Z`
 * (what `@connectrpc/connect-node` declares for `@connectrpc/connect`) or a caret range.
 * Anything else is `undefined` (unknown), and the caller skips rather than guess.
 */
export function satisfiesPeerRange(version: string, range: string): boolean | undefined {
    if (range.startsWith("^")) return satisfiesCaret(version, range);
    const exact = parseVersion(range);
    const loaded = parseVersion(version);
    if (!exact || !loaded) return undefined;
    // Build metadata does not distinguish versions; everything else must match exactly.
    return version.split("+")[0] === range.split("+")[0];
}

/** Real directory of a package directory, or the directory itself if it cannot be resolved. */
function realDir(dir: string): string {
    try {
        return realpathSync(dir);
    } catch {
        return dir;
    }
}

/** The nearest manifest named `packageName` above a resolved entry (file URL or path), or `undefined`. */
function manifestOf(entry: string, packageName: string): { dir: string; version: string; manifest: Record<string, unknown> } | undefined {
    const file = entry.startsWith("file:") ? fileURLToPath(entry) : entry;
    if (!isAbsolute(file)) return undefined;
    const found = nearestNamedManifest(dirname(file));
    if (!found || found.manifest.name !== packageName || typeof found.manifest.version !== "string") return undefined;
    return { dir: found.dir, version: found.manifest.version, manifest: found.manifest };
}

/**
 * Check the loaded copies against core's peer ranges, and `@connectrpc/connect-node`
 * against the exact `@connectrpc/connect` it declares.
 *
 * @param options.selfUrl - URL of the module doing the check (`import.meta.url`); its
 *   nearest named manifest must be `@connectum/core`, otherwise core is bundled and the
 *   check is skipped
 * @param options.resolve - resolves a bare specifier exactly as the checking module's
 *   own imports do (`import.meta.resolve`); `undefined` when the runtime has none
 * @param options.resolveFrom - resolves a bare specifier as a module at `fromUrl` would
 *   (`createRequire(fromUrl).resolve`), to see which `@connectrpc/connect` connect-node
 *   itself loads; `undefined` skips the lockstep part only
 */
export function checkPeerVersions(options: {
    selfUrl: string | undefined;
    resolve: ((specifier: string) => string) | undefined;
    resolveFrom?: ((fromUrl: string, specifier: string) => string) | undefined;
}): PeerVersionReport {
    const { selfUrl, resolve, resolveFrom } = options;
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
    /** What core loads, per library: the entry URL and its manifest. */
    const loaded = new Map<string, { entry: string; dir: string; version: string; manifest: Record<string, unknown> }>();
    for (const packageName of CHECKED_PEERS) {
        let entry: string;
        try {
            entry = resolve(packageName);
        } catch {
            // Not resolvable from core: the import itself would have failed earlier.
            continue;
        }
        if (!entry.startsWith("file:")) continue;
        const found = manifestOf(entry, packageName);
        if (!found) continue;
        loaded.set(packageName, { entry, ...found });
        const requiredRange = peers[packageName];
        if (typeof requiredRange !== "string") continue;
        if (satisfiesCaret(found.version, requiredRange) === false) {
            problems.push({ kind: "range", packageName, loadedVersion: found.version, requiredRange, requiredBy: "@connectum/core", loadedFrom: found.dir });
        }
    }

    // Lockstep: connect-node publishes ONE exact connect version as its peer, and equal
    // caret ranges cannot keep the two together. Check the connect that connect-node
    // itself loads — resolved from connect-node's own location — against that peer, and
    // that it is the same copy core loads.
    const connectNode = loaded.get("@connectrpc/connect-node");
    const coreConnect = loaded.get("@connectrpc/connect");
    const nodePeer = (connectNode?.manifest.peerDependencies as Record<string, unknown> | undefined)?.["@connectrpc/connect"];
    if (connectNode && typeof nodePeer === "string" && typeof resolveFrom === "function") {
        let entry: string | undefined;
        try {
            entry = resolveFrom(connectNode.entry, "@connectrpc/connect");
        } catch {
            entry = undefined;
        }
        const nodeConnect = entry === undefined ? undefined : manifestOf(entry, "@connectrpc/connect");
        if (nodeConnect) {
            const requiredBy = `@connectrpc/connect-node@${connectNode.version}`;
            if (satisfiesPeerRange(nodeConnect.version, nodePeer) === false) {
                problems.push({
                    kind: "range",
                    packageName: "@connectrpc/connect",
                    loadedVersion: nodeConnect.version,
                    requiredRange: nodePeer,
                    requiredBy,
                    loadedFrom: nodeConnect.dir,
                });
            }
            if (coreConnect && realDir(coreConnect.dir) !== realDir(nodeConnect.dir)) {
                problems.push({
                    kind: "split",
                    packageName: "@connectrpc/connect",
                    loadedVersion: nodeConnect.version,
                    requiredRange: nodePeer,
                    requiredBy,
                    loadedFrom: nodeConnect.dir,
                    otherCopy: coreConnect.dir,
                });
            }
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
        // createRequire resolves with the "require" condition, which may pick a different
        // entry FILE than an import would, but always inside the same package directory —
        // and the directory's manifest is all the check reads.
        const resolveFrom = (fromUrl: string, specifier: string) => createRequire(fromUrl).resolve(specifier);
        cached = checkPeerVersions({ selfUrl: import.meta.url, resolve, resolveFrom });
    }
    if (cached.status === "checked" && cached.problems.length > 0) {
        throw new PeerDependencyVersionError(cached.problems);
    }
}
