/**
 * Which copies of protobuf and Connect does an installed consumer actually run with?
 *
 * Generated message types from one copy of `@bufbuild/protobuf` do not type-check
 * against another, and Connect's `connect-node` requires one exact `connect` version, so
 * the framework promises a consumer ONE shared copy of each of these libraries among the
 * packages that exchange their values at runtime. This module measures that promise on a
 * real `node_modules`, whatever layout the package manager produced (npm's hoisted tree,
 * pnpm's symlinked store, Bun's tree): starting at the consumer, it follows every
 * dependency and peer edge between runtime participants and resolves each edge the way
 * Node resolves a bare specifier — the nearest `node_modules/<name>` walking up from the
 * requiring package's real location. Two edges that land on different real directories
 * are two copies, which is exactly the failure a consumer would hit.
 *
 * Build-time tools are deliberately NOT participants: `@connectum/cli` and
 * `@connectum/protoc-gen-catalog` pull `@bufbuild/protoplugin`, which pins
 * `@bufbuild/protobuf` exactly, so their copy cannot be promised to match the
 * consumer's. They never exchange values with the running service.
 *
 * @module scripts/lib/runtime-participants
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";

/** The libraries the single-copy promise is about. */
export const CONTRACT_LIBRARIES = ["@bufbuild/protobuf", "@connectrpc/connect", "@connectrpc/connect-node"];

/** Framework packages that are build tools, not runtime participants (see module doc). */
export const TOOL_PACKAGES = new Set(["@connectum/cli", "@connectum/protoc-gen-catalog"]);

/**
 * Third-party packages that hand protobuf or Connect values to the framework at runtime:
 * the validation interceptor's engine and the reflection service implementation.
 */
const THIRD_PARTY_PARTICIPANTS = new Set([...CONTRACT_LIBRARIES, "@connectrpc/validate", "@bufbuild/protovalidate", "@lambdalisue/connectrpc-grpcreflect"]);

/**
 * Known third-party exception, named so it cannot widen silently:
 * `@lambdalisue/connectrpc-grpcreflect` (behind `@connectum/reflection`) declares protobuf
 * and Connect as REGULAR dependencies (`^2.10.1` / `^2.1.1`), so a manager may give it its
 * own copy next to the application's — measured with Bun 1.4.2 on a cold cache, where it
 * received `@bufbuild/protobuf` 2.16.0 beside a 2.12.1 pin. No manifest of ours can
 * prevent that. Its dependency edges are therefore not followed: whatever IT resolves is
 * reported under `excused`, not counted as a copy. Every other participant still must
 * share one copy. The exception goes away with Connectum's own gRPC Server Reflection
 * implementation, which removes this package; delete the entry then, and the single-copy
 * assertion covers the reflection service again.
 */
export const EXCUSED_REQUIRERS = new Set(["@lambdalisue/connectrpc-grpcreflect"]);

/** @param {string} name */
export function isParticipant(name) {
    if (name.startsWith("@connectum/")) return !TOOL_PACKAGES.has(name);
    return THIRD_PARTY_PARTICIPANTS.has(name);
}

/**
 * Resolve a bare package name from a package directory the way Node does: the nearest
 * `node_modules/<name>` walking up from the requiring package's real path.
 *
 * @param {string} fromDir - real directory of the requiring package
 * @param {string} name
 * @returns {string | undefined} real directory of the resolved package
 */
function resolvePackageDir(fromDir, name) {
    let dir = fromDir;
    for (;;) {
        const candidate = join(dir, "node_modules", name);
        if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/** @param {string} dir */
function readManifest(dir) {
    return JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
}

/**
 * Walk the runtime participants of an installed consumer.
 *
 * @param {string} consumerDir - the consumer project root (with its `node_modules`)
 * @returns {{
 *   packages: Map<string, Map<string, { version: string, manifest: Record<string, any>, requiredBy: Set<string> }>>,
 *   unresolved: { from: string, name: string, kind: "dependency" | "peer" }[],
 *   excused: { from: string, name: string, version: string, dir: string }[],
 * }} `packages`: participant name -> real directory -> the copy found there;
 *   `excused`: what an EXCUSED_REQUIRERS package resolved (reported, not counted)
 */
export function collectParticipants(consumerDir) {
    const rootDir = realpathSync(consumerDir);
    const rootManifest = readManifest(rootDir);
    /** @type {Map<string, Map<string, { version: string, manifest: Record<string, any>, requiredBy: Set<string> }>>} */
    const packages = new Map();
    const unresolved = [];
    const excused = [];
    const visited = new Set([rootDir]);
    const queue = [{ dir: rootDir, manifest: rootManifest, label: "(consumer)", isRoot: true }];

    while (queue.length > 0) {
        const { dir, manifest, label, isRoot } = queue.shift();
        if (EXCUSED_REQUIRERS.has(manifest.name)) {
            for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
                if (!CONTRACT_LIBRARIES.includes(name)) continue;
                const target = resolvePackageDir(dir, name);
                if (target !== undefined) excused.push({ from: label, name, version: readManifest(target).version, dir: target });
            }
            continue;
        }
        const edges = [
            ...Object.keys(manifest.dependencies ?? {}).map((name) => ({ name, kind: "dependency" })),
            ...(isRoot ? Object.keys(manifest.devDependencies ?? {}).map((name) => ({ name, kind: "dependency" })) : []),
            ...Object.keys(manifest.peerDependencies ?? {}).map((name) => ({ name, kind: "peer" })),
        ];
        for (const { name, kind } of edges) {
            if (!isParticipant(name)) continue;
            const target = resolvePackageDir(dir, name);
            if (target === undefined) {
                const optional = manifest.peerDependenciesMeta?.[name]?.optional === true;
                if (!optional) unresolved.push({ from: label, name, kind });
                continue;
            }
            const targetManifest = readManifest(target);
            let copies = packages.get(name);
            if (!copies) {
                copies = new Map();
                packages.set(name, copies);
            }
            let copy = copies.get(target);
            if (!copy) {
                copy = { version: targetManifest.version, manifest: targetManifest, requiredBy: new Set() };
                copies.set(target, copy);
            }
            copy.requiredBy.add(label);
            if (!visited.has(target)) {
                visited.add(target);
                queue.push({ dir: target, manifest: targetManifest, label: `${name}@${targetManifest.version}`, isRoot: false });
            }
        }
    }
    return { packages, unresolved, excused };
}

/**
 * Human-readable notes for the excused edges whose copy is NOT the one the rest of the
 * runtime shares — the split the exception tolerates, printed so it stays visible.
 *
 * @param {ReturnType<typeof collectParticipants>} participants
 * @returns {string[]}
 */
export function excusedSplitNotes(participants) {
    const notes = [];
    for (const e of participants.excused) {
        const shared = participants.packages.get(e.name);
        if (shared?.has(e.dir)) continue;
        notes.push(`${e.from} has its own ${e.name}@${e.version} (known exception: its protobuf / Connect are regular dependencies; removed with native gRPC reflection)`);
    }
    return notes;
}

/**
 * The single-copy verdict for the contract libraries.
 *
 * @param {ReturnType<typeof collectParticipants>} participants
 * @returns {string[]} human-readable problems; empty means exactly one copy of each
 */
export function singleCopyProblems(participants) {
    const problems = [];
    for (const name of CONTRACT_LIBRARIES) {
        const copies = participants.packages.get(name);
        if (!copies || copies.size === 0) {
            problems.push(`${name}: not installed for any runtime participant`);
            continue;
        }
        if (copies.size > 1) {
            const detail = [...copies.values()].map((c) => `${c.version} (required by ${[...c.requiredBy].join(", ")})`).join("; ");
            problems.push(`${name}: ${copies.size} copies — ${detail}`);
        }
    }
    for (const miss of participants.unresolved) {
        if (CONTRACT_LIBRARIES.includes(miss.name)) {
            problems.push(`${miss.name}: ${miss.kind} of ${miss.from} does not resolve`);
        }
    }
    return problems;
}

/**
 * Check every participant's peer range on a contract library against the copy it
 * actually resolves. This is what catches a `connect` / `connect-node` pair out of
 * lockstep: `connect-node` publishes an EXACT `connect` peer, so equal caret ranges in
 * our manifests do not keep the two installed versions together.
 *
 * @param {ReturnType<typeof collectParticipants>} participants
 * @param {{ satisfies(version: string, range: string, options?: object): boolean }} semver - npm's `semver`, injected so callers without it can still use the rest of this module
 * @returns {string[]} human-readable problems; empty means every peer range is honored
 */
export function peerRangeProblems(participants, semver) {
    const problems = [];
    // Resolve each peer from the requirer's own real directory: that is the copy the
    // requirer runs with, whatever the manager placed at the top of the tree.
    for (const [requirerName, copies] of participants.packages) {
        for (const [requirerDir, requirer] of copies) {
            for (const [peerName, range] of Object.entries(requirer.manifest.peerDependencies ?? {})) {
                if (!CONTRACT_LIBRARIES.includes(peerName)) continue;
                const target = resolvePackageDir(requirerDir, peerName);
                if (target === undefined) continue; // reported by singleCopyProblems as unresolved
                const { version } = readManifest(target);
                if (!semver.satisfies(version, range, { includePrerelease: true })) {
                    problems.push(`${requirerName}@${requirer.version} requires ${peerName}@"${range}" but resolves ${version}`);
                }
            }
        }
    }
    return problems;
}

/**
 * Compare every installed `@connectum/*` participant with an expected manifest, to prove
 * the install used the candidate tarballs and not a published version of the same number.
 *
 * @param {ReturnType<typeof collectParticipants>} participants
 * @param {Map<string, Record<string, unknown>>} expected - package name -> manifest packed in its tarball
 * @returns {string[]} human-readable problems; empty means every copy is the candidate
 */
export function candidateProblems(participants, expected) {
    const problems = [];
    for (const [name, copies] of participants.packages) {
        if (!name.startsWith("@connectum/")) continue;
        const want = expected.get(name);
        if (!want) {
            problems.push(`${name}: installed, but no candidate tarball was built for it`);
            continue;
        }
        for (const copy of copies.values()) {
            if (JSON.stringify(copy.manifest) !== JSON.stringify(want)) {
                problems.push(`${name}@${copy.version}: installed manifest differs from the candidate tarball (a published copy was installed instead)`);
            }
        }
    }
    return problems;
}
