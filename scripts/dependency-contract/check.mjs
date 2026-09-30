#!/usr/bin/env node
/**
 * Package-manager matrix for the framework's dependency contract.
 *
 * `@connectum/*` runtime packages declare `@bufbuild/protobuf`, `@connectrpc/connect`
 * and (where used at runtime) `@connectrpc/connect-node` as peer dependencies, so that a
 * consumer runs with ONE copy of each. Two copies make generated types from one copy fail
 * to type-check against the other, and a `connect-node` next to the wrong `connect` is an
 * unsupported pair. This script proves the contract the way a consumer meets it: it
 * installs the framework into throwaway consumer projects with npm, pnpm and Bun, OUTSIDE
 * the workspace (whose `@bufbuild/protobuf` override would hide a duplicate), and checks
 * what actually landed in `node_modules`.
 *
 * Scenarios (consumer pins -> expected outcome):
 * - `in-range`       — pins at the peer floors: install succeeds, exactly one copy of each
 *                      contract library among runtime participants, at the pinned version,
 *                      and every participant's peer range holds (which includes the
 *                      installed `connect` matching `connect-node`'s exact `connect` peer).
 * - `peers-omitted`  — no pins at all: npm, pnpm and Bun install the missing peers
 *                      themselves; the same single-copy and peer-range checks hold.
 * - `protobuf-below` — `@bufbuild/protobuf` pinned below the floor: npm refuses the tree
 *                      (ERESOLVE); pnpm and Bun install but print a peer warning naming it.
 * - `connect-below`  — `@connectrpc/connect` pinned below the floor, `connect-node` left
 *                      to the manager: the same visible failure / warning.
 * The expected per-manager outcomes are the EXPECTATIONS table below; a run that differs
 * from it fails, whichever way it differs.
 *
 * Sources (`--source`):
 * - `pack` (default) — build the workspace and `pnpm pack` every package, then install
 *   those tarballs. Every installed `@connectum/*` copy is compared with the manifest in
 *   its tarball, so an install that silently fell back to a published version of the same
 *   number fails instead of passing on the wrong code.
 * - `published --version <x.y.z>` — install that published version from npm with the same
 *   expectations. Run against a release that predates the contract (1.2.0) it must FAIL:
 *   that is how this check was shown to tell the contract apart from its absence.
 *
 * Deterministic inputs: every `@connectum/*` package comes from the tarballs (or one
 * published version), and the in-range / below-floor pins are exact versions. Other
 * third-party dependencies resolve fresh from the registry, like any first install.
 * `peers-omitted` lets the manager choose the contract libraries' versions on purpose —
 * that is the case where an upstream release could split them.
 *
 * Usage:
 *   pnpm dependency-contract:check                               # all managers, all scenarios, packed candidate
 *   pnpm dependency-contract:check --pm npm,pnpm                 # only these managers
 *   pnpm dependency-contract:check --scenario in-range           # only these scenarios
 *   pnpm dependency-contract:check --source published --version 1.2.0
 *   pnpm dependency-contract:check --keep                        # keep the consumer projects in .tmp/
 *   pnpm dependency-contract:check --ignore-release-age          # lift a host minimum-release-age policy
 *
 * A host `minimumReleaseAge` policy (pnpm, Bun's bunfig) blocks releases younger than its
 * window, and the peer floors deliberately point at recent releases. Such a run fails
 * with "blocked by minimum-release-age"; `--ignore-release-age` lifts the policy for these
 * throwaway installs only. CI runners carry no such policy.
 *
 * Needs npm, pnpm and bun on PATH for the managers selected. Exit code is non-zero when
 * any cell differs from its expectation; a summary table is always printed.
 *
 * @module scripts/dependency-contract/check
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import semver from "semver";
import { listPublishablePackages, packWorkspace, readPackedManifest } from "../lib/pack-workspace.mjs";
import { CONTRACT_LIBRARIES, candidateProblems, collectParticipants, peerRangeProblems, singleCopyProblems, TOOL_PACKAGES } from "../lib/runtime-participants.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRATCH_ROOT = join(REPO_ROOT, ".tmp");

const MANAGERS = ["npm", "pnpm", "bun"];

/**
 * Consumer pins per scenario. The floors mirror the published peer ranges
 * (`^2.16.0` / `^2.2.0`); "below" pins are the last releases under those floors.
 */
const SCENARIOS = {
    "in-range": { "@bufbuild/protobuf": "2.16.0", "@connectrpc/connect": "2.2.0", "@connectrpc/connect-node": "2.2.0" },
    "peers-omitted": {},
    "protobuf-below": { "@bufbuild/protobuf": "2.12.1", "@connectrpc/connect": "2.2.0", "@connectrpc/connect-node": "2.2.0" },
    "connect-below": { "@connectrpc/connect": "2.1.2" },
};

/**
 * The peer complaint each manager shows for one library, as measured with npm 11.19,
 * pnpm 11.0 and Bun 1.4:
 * - npm refuses the tree: `ERESOLVE unable to resolve dependency tree` followed by
 *   `peer <lib>@"<range>" from <package>`;
 * - pnpm prints only `Issues with peer dependencies found. Run "pnpm peers check"`, and
 *   `pnpm peers check` names the library as `✕ unmet peer <lib>` — so for pnpm the
 *   signal searched is the install output plus the `pnpm peers check` report;
 * - Bun prints `warn: incorrect peer dependency "<lib>@<installed version>"`.
 */
const PEER_COMPLAINT = {
    npm: (lib) => new RegExp(`peer ${escapeRegExp(lib)}@"`),
    pnpm: (lib) => new RegExp(`unmet peer ${escapeRegExp(lib)}$`, "m"),
    bun: (lib) => new RegExp(`incorrect peer dependency "${escapeRegExp(lib)}@`),
};

/**
 * What each cell must show.
 * - `install`: "ok" (exit 0) or "fail" (non-zero exit);
 * - `complaintAbout`: the library the manager must visibly complain about (see
 *   PEER_COMPLAINT); for in-range cells, NO contract library may be complained about;
 * - `contract`: true = single copy + peer ranges honored + installed pins as requested;
 *   false = the installed tree must show the violation the complaint announced.
 * Candidate provenance (installed manifests equal the tarballs) is checked on every
 * successful `pack` install regardless.
 *
 * Measured outcome behind the pnpm / Bun rows: both install ONE copy — the consumer's
 * too-old pin — and leave every framework package's peer range unmet; neither nests a
 * second, in-range copy.
 *
 * `complaintRequired: false` marks the one cell where the manager stays silent: Bun
 * (1.4.2) prints no peer warning for a too-old `@bufbuild/protobuf` when ANOTHER, in-range
 * copy exists elsewhere in the tree — here the one `@bufbuild/protoplugin` pins exactly
 * under the catalog plugin, as it does under `protoc-gen-es` in every generated project.
 * Without such a copy Bun does warn. The cell still asserts the installed violation, so
 * the silent case is documented rather than hidden, and a Bun that starts warning passes.
 */
const EXPECTATIONS = {
    "in-range": { npm: inRange(), pnpm: inRange(), bun: inRange() },
    "peers-omitted": { npm: inRange(), pnpm: inRange(), bun: inRange() },
    "protobuf-below": {
        npm: { install: "fail", complaintAbout: "@bufbuild/protobuf", contract: false },
        pnpm: { install: "ok", complaintAbout: "@bufbuild/protobuf", contract: false },
        bun: { install: "ok", complaintAbout: "@bufbuild/protobuf", complaintRequired: false, contract: false },
    },
    "connect-below": {
        npm: { install: "fail", complaintAbout: "@connectrpc/connect", contract: false },
        pnpm: { install: "ok", complaintAbout: "@connectrpc/connect", contract: false },
        bun: { install: "ok", complaintAbout: "@connectrpc/connect", contract: false },
    },
};

function inRange() {
    return { install: "ok", complaintAbout: undefined, contract: true };
}

/** @param {string} text */
function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function parseArgs(argv) {
    const opts = { pms: MANAGERS, scenarios: Object.keys(SCENARIOS), source: "pack", version: undefined, keep: false, ignoreReleaseAge: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--pm") opts.pms = (argv[++i] ?? "").split(",").filter(Boolean);
        else if (arg === "--scenario") opts.scenarios = (argv[++i] ?? "").split(",").filter(Boolean);
        else if (arg === "--source") opts.source = argv[++i];
        else if (arg === "--version") opts.version = argv[++i];
        else if (arg === "--keep") opts.keep = true;
        else if (arg === "--ignore-release-age") opts.ignoreReleaseAge = true;
        else if (arg === "--help" || arg === "-h") opts.help = true;
        else throw new Error(`dependency-contract: unknown argument "${arg}" (try --help)`);
    }
    for (const pm of opts.pms) if (!MANAGERS.includes(pm)) throw new Error(`dependency-contract: unknown --pm "${pm}" (known: ${MANAGERS.join(", ")})`);
    for (const s of opts.scenarios) if (!(s in SCENARIOS)) throw new Error(`dependency-contract: unknown --scenario "${s}" (known: ${Object.keys(SCENARIOS).join(", ")})`);
    if (opts.source !== "pack" && opts.source !== "published") throw new Error(`dependency-contract: --source must be pack or published`);
    if (opts.source === "published" && !opts.version) throw new Error("dependency-contract: --source published needs --version <x.y.z>");
    return opts;
}

/**
 * The consumer's `@connectum/*` specifiers: every runtime package as a dependency, the
 * testing packages as devDependencies (where a real project keeps them), and the catalog
 * plugin as a devDependency too — a real consumer has it, and it proves the build tool's
 * own exact protobuf pin does not leak into the runtime participants.
 */
function connectumSpecs(opts, tarballs) {
    const spec = (name) => (opts.source === "pack" ? `file:${tarballs.get(name)}` : opts.version);
    const names = listPublishablePackages(REPO_ROOT)
        .map((p) => p.name)
        .filter((n) => n !== "@connectum/cli");
    const dev = new Set(["@connectum/testing", "@connectum/test-fixtures", "@connectum/protoc-gen-catalog"]);
    const dependencies = {};
    const devDependencies = {};
    for (const name of names) (dev.has(name) ? devDependencies : dependencies)[name] = spec(name);
    return { dependencies, devDependencies, all: Object.fromEntries(names.map((n) => [n, spec(n)])) };
}

/** Write a consumer project for one cell. */
function writeConsumer(dir, pm, scenario, specs, opts) {
    mkdirSync(dir, { recursive: true });
    const pins = SCENARIOS[scenario];
    const manifest = {
        name: `dependency-contract-${pm}-${scenario}`,
        version: "0.0.0",
        private: true,
        type: "module",
        dependencies: sortKeys({ ...specs.dependencies, ...pins }),
        devDependencies: sortKeys(specs.devDependencies),
    };
    if (opts.source === "pack" && pm !== "pnpm") {
        // npm and Bun honor `overrides` from the root manifest only. Every @connectum name
        // is pinned to its tarball so a transitive edge (testing -> test-fixtures, a peer
        // on core) cannot fetch the published package of the same version. npm allows an
        // override of a direct dependency only with the identical spec — which this is.
        manifest.overrides = sortKeys(specs.all);
    }
    writeFileSync(join(dir, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    if (pm === "pnpm") {
        // A pnpm-workspace.yaml makes this directory its own root (the repo's workspace,
        // with its protobuf override, must not apply) and is where pnpm 11 reads
        // `overrides` and build approvals from.
        const lines = ["packages:", "  - '.'", "allowBuilds:", "  esbuild: true", "  protobufjs: true"];
        if (opts.source === "pack") {
            lines.push("overrides:", ...Object.entries(specs.all).map(([n, s]) => `  '${n}': '${s}'`));
        }
        writeFileSync(join(dir, "pnpm-workspace.yaml"), `${lines.join("\n")}\n`);
    }
}

function sortKeys(obj) {
    return Object.fromEntries(Object.entries(obj).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/**
 * @param {string} pm
 * @param {{ ignoreReleaseAge: boolean }} opts
 */
function installCommand(pm, opts) {
    if (pm === "npm") return ["npm", ["install", "--no-audit", "--no-fund"]];
    // A host-wide minimum-release-age policy (pnpm `minimumReleaseAge`, Bun
    // `install.minimumReleaseAge`) blocks the fresh releases the peer floors point at.
    // Only an explicit --ignore-release-age lifts it, and only for this throwaway install.
    if (pm === "pnpm") return ["pnpm", ["install", ...(opts.ignoreReleaseAge ? ["--config.minimumReleaseAge=0"] : [])]];
    return ["bun", ["install", ...(opts.ignoreReleaseAge ? ["--minimum-release-age=0"] : [])]];
}

/**
 * Everything the consumer is shown about peers: the install output, plus for pnpm the
 * `pnpm peers check` report its install warning points to.
 */
function peerSignal(pm, dir, installOutput) {
    if (pm !== "pnpm") return installOutput;
    const report = spawnSync("pnpm", ["peers", "check"], { cwd: dir, encoding: "utf8" });
    return `${installOutput}\n${report.stdout ?? ""}${report.stderr ?? ""}`;
}

/** Run one cell and compare it with its expectation. */
function runCell({ pm, scenario, workdir, specs, expectedManifests, opts }) {
    const dir = join(workdir, `${pm}-${scenario}`);
    writeConsumer(dir, pm, scenario, specs, opts);
    const [cmd, args] = installCommand(pm, opts);
    const started = Date.now();
    const result = spawnSync(cmd, args, { cwd: dir, encoding: "utf8", env: { ...process.env, CI: "true" } });
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    const installed = result.status === 0;
    const expected = EXPECTATIONS[scenario][pm];
    const problems = [];

    if (installed !== (expected.install === "ok")) {
        problems.push(`install ${installed ? "succeeded" : `failed (exit ${result.status})`}, expected it to ${expected.install === "ok" ? "succeed" : "fail"}`);
    }
    const signal = peerSignal(pm, dir, output);
    if (expected.complaintAbout) {
        const pattern = PEER_COMPLAINT[pm](expected.complaintAbout);
        if (expected.complaintRequired !== false && !pattern.test(signal)) {
            problems.push(`${pm} shows no peer complaint about ${expected.complaintAbout} (looked for ${pattern})`);
        }
    } else {
        for (const lib of CONTRACT_LIBRARIES) {
            const pattern = PEER_COMPLAINT[pm](lib);
            if (pattern.test(signal)) problems.push(`${pm} complains about the peer ${lib} although every pin is in range`);
        }
    }

    let contractProblems = [];
    if (installed) {
        const participants = collectParticipants(dir);
        contractProblems = [...singleCopyProblems(participants), ...peerRangeProblems(participants, semver)];
        for (const [name, pin] of Object.entries(SCENARIOS[scenario])) {
            const copies = [...(participants.packages.get(name)?.values() ?? [])];
            if (copies.some((c) => c.version !== pin)) {
                contractProblems.push(`${name}: pinned ${pin}, runtime participants use ${copies.map((c) => c.version).join(", ")}`);
            }
        }
        if (opts.source === "pack") problems.push(...candidateProblems(participants, expectedManifests));
    }
    if (expected.contract && contractProblems.length > 0) {
        problems.push(...contractProblems);
    } else if (!expected.contract && installed && contractProblems.length === 0) {
        problems.push("the out-of-range pin installed with no contract violation — expected the pin to be visibly outside the peer range");
    }

    return { pm, scenario, ok: problems.length === 0, ms: Date.now() - started, problems, contractProblems, output, signal };
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(
            [
                "Usage: pnpm dependency-contract:check [options]",
                "",
                `  --pm <a,b>          managers to run (default: ${MANAGERS.join(",")})`,
                `  --scenario <a,b>    scenarios to run (default: ${Object.keys(SCENARIOS).join(",")})`,
                "  --source pack       install locally packed tarballs of this workspace (default)",
                "  --source published --version <x.y.z>   install a published version instead",
                "  --keep              keep the consumer projects for inspection",
                "  --ignore-release-age  lift a host minimum-release-age policy (pnpm, Bun) for these installs only",
            ].join("\n"),
        );
        return;
    }

    mkdirSync(SCRATCH_ROOT, { recursive: true });
    const workdir = mkdtempSync(join(SCRATCH_ROOT, "dependency-contract-"));
    const results = [];
    try {
        let tarballs = new Map();
        const expectedManifests = new Map();
        if (opts.source === "pack") {
            console.log("Building and packing the workspace...");
            tarballs = packWorkspace({ repoRoot: REPO_ROOT, dest: join(workdir, "tarballs") });
            for (const [name, tarball] of tarballs) {
                if (!TOOL_PACKAGES.has(name)) expectedManifests.set(name, readPackedManifest(tarball));
            }
        }
        const specs = connectumSpecs(opts, tarballs);
        const target = opts.source === "pack" ? "packed workspace" : `published ${opts.version}`;
        console.log(`\nDependency contract: ${target}; ${opts.pms.join(", ")} x ${opts.scenarios.join(", ")} in ${workdir}\n`);
        for (const pm of opts.pms) {
            const probe = spawnSync(pm, ["--version"], { encoding: "utf8" });
            if (probe.status !== 0) throw new Error(`dependency-contract: ${pm} is not on PATH`);
            console.log(`  ${pm} ${probe.stdout.trim()}`);
        }
        console.log("");
        for (const pm of opts.pms) {
            for (const scenario of opts.scenarios) {
                process.stdout.write(`  ${pm.padEnd(5)} ${scenario.padEnd(15)} `);
                const r = runCell({ pm, scenario, workdir, specs, expectedManifests, opts });
                results.push(r);
                console.log(`${r.ok ? "ok  " : "FAIL"} (${(r.ms / 1000).toFixed(1)}s)`);
                // Out-of-range cells print what the consumer sees, so the log documents the
                // exact visible failure or warning rather than only a pass mark.
                if (EXPECTATIONS[scenario][pm].contract === false) {
                    const visible = r.signal
                        .split("\n")
                        .filter((l) => /ERESOLVE|npm error peer|unmet peer|incorrect peer dependency|Issues with peer dependencies/.test(l))
                        .slice(0, 6);
                    if (visible.length === 0) console.log(`        | (${pm} printed no peer complaint)`);
                    for (const line of visible) console.log(`        | ${line.trimEnd()}`);
                    for (const p of r.contractProblems) console.log(`        > ${p}`);
                }
            }
        }
    } finally {
        if (opts.keep) console.log(`\nConsumer projects kept in ${workdir}`);
        else rmSync(workdir, { recursive: true, force: true });
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
        console.log("");
        for (const r of failed) {
            const tail = r.output.trimEnd().split("\n").slice(-20).join("\n");
            console.log(`--- ${r.pm} ${r.scenario} ---\n${r.problems.map((p) => `  - ${p}`).join("\n")}\n  install output (tail):\n${tail}\n`);
        }
        console.log(`${failed.length} of ${results.length} cell(s) differ from the expected outcome.`);
        process.exitCode = 1;
        return;
    }
    console.log(`\nAll ${results.length} cell(s) match the dependency contract.`);
}

try {
    main();
} catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
