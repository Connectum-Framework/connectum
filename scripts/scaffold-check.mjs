#!/usr/bin/env node
/**
 * Local reproduction of the `cli-scaffold-matrix` CI gate.
 *
 * For each named module combination: scaffold a project with the freshly built CLI,
 * install it, then run `typecheck` (which runs `buf generate` first) and `test`. A
 * broken module fragment fails here instead of in CI — or, worse, in a user's `init`.
 * A combination with a `fixture` also gets user-style files copied in after `init`
 * (see FIXTURES), a plain-`node` run of its check file, and a manifest check against
 * the CLI's version floors.
 * A combination with auth or events imports Connectum's option descriptors from those
 * packages instead of generating them, so it is also checked for that: one `@connectum/*`
 * range at the slice floor (before install), and after generation no local
 * `connectum/<p>/v1/options_pb.ts` in gen/, generated imports from the package subpath,
 * and that subpath loading from the project. The floor is the release that first ships
 * those subpaths, so until it is published these combinations run against the packed
 * workspace (`pack: true` in COMBOS).
 *
 * This file owns the combination list; `.github/workflows/cli-scaffold-matrix.yml` does
 * not restate it. That workflow calls `--list` to build its matrix and then runs one
 * cell per name, so a green run here means a green run there by construction rather
 * than by two lists being kept in step by hand.
 *
 * WHAT IS DETERMINISTIC, AND WHAT IS NOT — this matters when reading a failure:
 * - The base project IS pinned: `connectum init` fetches `DEFAULT_BASE_REF`, a tag,
 *   unless `--ref` overrides it. Two runs fetch identical base sources.
 * - The dependency tree is NOT pinned: the scaffolded project has no lockfile and
 *   depends on published `@connectum/*` and third-party ranges, so an install can pull
 *   newer patch versions than the previous run. A failure that appears without any
 *   local change is therefore a real signal about the published surface, not noise to
 *   be retried away.
 * - `--ref main` (`--drift`) is deliberately NOT deterministic: it is the local twin of
 *   the `init base-drift` cell and tracks the live example on purpose.
 *
 * PUBLISHED VS. PACKED FRAMEWORK (`--pack`):
 * By default a scaffolded project installs the PUBLISHED `@connectum/*`, so this check
 * proves the CLI against what users get today — and cannot see a packaging change (a new
 * peer dependency, a moved export) until it is released. `--pack` builds the workspace,
 * `pnpm pack`s every package and points the scaffolded project at those tarballs before
 * installing: npm and Bun through the direct dependency specs plus root `overrides`
 * (npm accepts an override of a direct dependency only with the identical spec, which is
 * what is written), pnpm through `overrides` in the `pnpm-workspace.yaml` that `init`
 * already writes (pnpm 11 reads no settings from package.json). After the install every
 * installed `@connectum/*` copy is compared with its tarball's manifest — an override
 * that silently fell back to the registry fails the cell — and the project must hold one
 * copy of `@bufbuild/protobuf` / `@connectrpc/connect` / `@connectrpc/connect-node` among
 * its runtime packages. Without `--pack`, only the combinations marked `pack` in COMBOS
 * install the packed workspace (see there); every other combination installs the
 * published packages, locally and in CI.
 *
 * Usage:
 *   pnpm scaffold:check                     # the default combos, pinned base
 *   pnpm scaffold:check --combo auth,otel   # only the named combos
 *   pnpm scaffold:check --drift             # also run the kitchen sink against examples@main
 *   pnpm scaffold:check --keep              # keep the generated projects for inspection
 *   pnpm scaffold:check --runtime bun       # also run the Bun cell (requires bun on PATH)
 *   pnpm scaffold:check --pack              # install locally packed tarballs of this workspace
 *   pnpm scaffold:check --pack --combo kitchen-sink --pm pnpm   # a combo with another package manager
 *   pnpm scaffold:check --list              # combination names as JSON (CI builds its matrix from this)
 *
 * Exit code is non-zero if any combination fails; a summary table is always printed.
 *
 * @module scripts/scaffold-check
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// The floors come from the CLI's own table (read from source through native type
// stripping), so this check and `connectum init` cannot disagree about them.
import { CONNECTUM_SLICE_FLOOR, connectumSliceViolations, meetsFloor, SCAFFOLD_VERSION_FLOORS } from "../packages/cli/src/scaffold/versionFloors.ts";
import { packWorkspace, readPackedManifest } from "./lib/pack-workspace.mjs";
import { candidateProblems, collectParticipants, singleCopyProblems, TOOL_PACKAGES } from "./lib/runtime-participants.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = join(REPO_ROOT, "packages/cli/dist/index.js");
/** Scratch root: the repo's gitignored `.tmp/`, so `--keep` output is easy to find. */
const SCRATCH_ROOT = join(REPO_ROOT, ".tmp");

/**
 * Files copied into a scaffolded project after `init`, laid out as they land in it.
 * Each fixture names the extra step that proves it: `enums` adds a proto with a
 * top-level and a nested enum plus a check file that is type-checked by the project's
 * `typecheck` and then executed with plain `node` (native type stripping, no loader).
 * A TypeScript `enum` in the generated code fails the first with TS1294 and the second
 * with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
 */
const FIXTURES = {
    enums: { dir: join(REPO_ROOT, "scripts/scaffold-check-fixtures/enums"), nodeRun: "tests/fixture/enums.check.ts" },
};

/**
 * **The single source of truth for what gets scaffold-checked.**
 *
 * `cli-scaffold-matrix.yml` does not restate this list: it asks for it with
 * `--list` and builds its matrix from the answer, then runs one cell per name via
 * `--combo <name>`. Adding a combination here adds a CI cell, and there is no second
 * place that can silently disagree.
 *
 * `optional: true` keeps a combination out of a bare local run — `bun` needs `bun` on
 * PATH, and `base-drift` reaches for the live example branch — while still exposing it
 * to `--combo <name>` (which is how CI selects every cell) and to `--runtime bun` /
 * `--drift`.
 *
 * `pack: true` makes a combination install the packed workspace instead of the published
 * packages, with or without `--pack`. It belongs to a combination exactly when `init`
 * gives it a dependency range no published release satisfies yet: today, every one with
 * auth or events, whose `@connectum/*` set is floored at the release that first exports
 * the option-descriptor subpaths (versionFloors.ts). Kept here rather than in the
 * workflow so the workflow keeps reading nothing but `--list`, and a local bare run
 * behaves like its CI cell. Once that release is published, drop the property so these
 * cells go back to proving the published surface.
 */
const COMBOS = [
    { name: "base-node-pnpm", pm: "pnpm", args: [] },
    { name: "base-node-npm", pm: "npm", args: [] },
    { name: "otel", pm: "npm", args: ["--otel"] },
    { name: "events-nats", pm: "npm", args: ["--events", "nats"], pack: true },
    { name: "auth", pm: "npm", args: ["--auth"], pack: true },
    { name: "catalog", pm: "npm", args: ["--catalog"] },
    // The only default cell with the catalog generator and the auth option module, so it
    // also carries the enum fixture: erasable generation must coexist with both.
    { name: "kitchen-sink", pm: "npm", args: ["--otel", "--events", "nats", "--auth", "--catalog", "--resilience", "retry,timeout"], fixture: "enums", pack: true },
    { name: "enums", pm: "npm", args: [], fixture: "enums" },
    // An older base whose manifest still declares protobuf-es ^2.11.0: `--ref` must keep
    // producing a project that generates erasable enums. Pinned to a tag, so deterministic.
    // It proves compatibility, not the floor — an install resolves the highest version in
    // range either way; the floor is proven by the manifest assertion and the unit tests.
    { name: "enums-base-v1.3.0", pm: "npm", args: ["--ref", "v1.3.0"], fixture: "enums" },
    // The same modules installed with pnpm. Only pnpm (11+) fails an install over a
    // dependency's build script that the generated pnpm-workspace.yaml neither approves
    // nor denies, and the scripts arrive with the modules (protobufjs comes in through
    // otel), so the npm cells above cannot see this class of failure and base-node-pnpm
    // installs none of those modules. One kitchen-sink cell rather than a pnpm twin of
    // every module cell: it pulls in the union of the module dependencies at the cost of
    // a single extra parallel job.
    { name: "kitchen-sink-pnpm", pm: "pnpm", args: ["--otel", "--events", "nats", "--auth", "--catalog", "--resilience", "retry,timeout"], pack: true },
    { name: "bun", pm: "npm", args: ["--runtime", "bun"], optional: true, needsBun: true },
    // The two axes are independent, so both crossings are worth a cell: the one above
    // runs a Bun-runtime project installed with npm, this one installs with bun and
    // runs on Node. `bun install` lays out an ordinary node_modules either way.
    { name: "bun-pm", pm: "bun", args: [], optional: true, needsBun: true },
    { name: "base-drift", pm: "npm", args: ["--ref", "main", "--otel", "--events", "nats", "--auth", "--catalog"], optional: true, pack: true },
];

/** Combinations that need `bun` on PATH — the only selector for them, locally and in CI. */
const BUN_COMBOS = COMBOS.filter((c) => c.needsBun === true);

/** Combinations a bare `pnpm scaffold:check` runs. */
const DEFAULT_COMBOS = COMBOS.filter((c) => c.optional !== true);

/** Parse `--flag value` / `--flag` arguments without pulling in a dependency. */
function parseArgs(argv) {
    const opts = { combos: undefined, drift: false, keep: false, list: false, runtime: undefined, pack: false, pm: undefined };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--drift") opts.drift = true;
        else if (arg === "--keep") opts.keep = true;
        else if (arg === "--list") opts.list = true;
        else if (arg === "--combo") opts.combos = (argv[++i] ?? "").split(",").filter(Boolean);
        else if (arg === "--runtime") opts.runtime = argv[++i];
        else if (arg === "--pack") opts.pack = true;
        else if (arg === "--pm") opts.pm = argv[++i];
        else if (arg === "--help" || arg === "-h") opts.help = true;
        else throw new Error(`scaffold-check: unknown argument "${arg}" (try --help)`);
    }
    return opts;
}

/** Run a command, streaming nothing; throw with the tail of the output on failure. */
function run(command, args, cwd) {
    try {
        execFileSync(command, args, { cwd, stdio: "pipe", encoding: "utf8" });
    } catch (cause) {
        const output = `${cause.stdout ?? ""}${cause.stderr ?? ""}`.trimEnd();
        const tail = output.split("\n").slice(-25).join("\n");
        throw new Error(`\`${command} ${args.join(" ")}\` failed in ${cwd}:\n${tail}`, { cause });
    }
}

/**
 * `--pack`: point a freshly scaffolded project at the local tarballs (see the module doc
 * for why each manager needs its own mechanism).
 *
 * @param {string} target - the scaffolded project directory
 * @param {string} pm - its package manager
 * @param {Map<string, string>} tarballs - package name -> tarball path
 */
function useLocalTarballs(target, pm, tarballs) {
    const specs = Object.fromEntries([...tarballs].map(([name, tarball]) => [name, `file:${tarball}`]));
    const manifestPath = join(target, "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const field of ["dependencies", "devDependencies"]) {
        for (const name of Object.keys(manifest[field] ?? {})) {
            if (name in specs) manifest[field][name] = specs[name];
        }
    }
    if (pm === "pnpm") {
        const workspaceFile = join(target, "pnpm-workspace.yaml");
        if (!existsSync(workspaceFile)) {
            throw new Error(`scaffold-check: ${workspaceFile} is missing — init writes it for pnpm, and the overrides must go there`);
        }
        const overrides = Object.entries(specs).map(([name, spec]) => `  '${name}': '${spec}'`);
        appendFileSync(workspaceFile, `overrides:\n${overrides.join("\n")}\n`);
    } else {
        // Also covers names the project never lists: test-fixtures arrives via testing,
        // and core can arrive as an auto-installed peer.
        manifest.overrides = specs;
    }
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

/**
 * `--pack`: prove the install used the tarballs and kept one copy of protobuf / Connect.
 *
 * @param {string} target
 * @param {Map<string, Record<string, unknown>>} packedManifests
 */
function assertPackedInstall(target, packedManifests) {
    const participants = collectParticipants(target);
    const problems = [...candidateProblems(participants, packedManifests), ...singleCopyProblems(participants)];
    if (problems.length > 0) {
        throw new Error(`the installed project does not match the packed workspace:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    }
}

/**
 * Assert the scaffolded manifest meets every CLI version floor. An install cannot show
 * this — package managers resolve the highest version in range, so a range below the
 * floor would still install a new enough version today — hence a direct manifest check.
 */
function assertVersionFloors(target) {
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    const violations = SCAFFOLD_VERSION_FLOORS.filter((floor) => !meetsFloor(pkg[floor.section]?.[floor.name], floor.version)).map(
        (floor) => `${floor.section}["${floor.name}"] is ${JSON.stringify(pkg[floor.section]?.[floor.name])}, below the floor ${floor.version}`,
    );
    if (violations.length > 0) {
        throw new Error(`scaffolded package.json is below the CLI version floors:\n${violations.join("\n")}`);
    }
}

/**
 * Connectum packages whose option descriptors the scaffolded project imports instead of
 * generating: the slice floor's triggers its manifest depends on. Empty for a scaffold
 * without auth and events, which keeps generating exactly as before.
 */
function optionImportPackages(target) {
    const pkg = JSON.parse(readFileSync(join(target, "package.json"), "utf8"));
    return CONNECTUM_SLICE_FLOOR.triggers.filter((name) => name in (pkg.dependencies ?? {}));
}

/**
 * Before install: a project that imports option descriptors from the packages must ask
 * for one `@connectum/*` range that has them. Checked on the manifest because an install
 * cannot show it — it resolves the highest version in range.
 */
function assertConnectumSlice(target) {
    const problems = connectumSliceViolations(JSON.parse(readFileSync(join(target, "package.json"), "utf8")));
    if (problems.length > 0) {
        throw new Error(`scaffolded package.json does not meet the @connectum/* slice floor:\n${problems.join("\n")}`);
    }
}

/**
 * After `buf generate`: the project holds no generated copy of Connectum's option
 * protos, its generated code imports them from the package subpath, and that subpath
 * resolves from the project at runtime. Any of the three failing means the project is
 * back to evaluating its own copy of the descriptors, or cannot load the package's.
 */
function assertOptionImports(target, packages) {
    const gen = join(target, "gen");
    const files = readdirSync(gen, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".ts"));
    const local = files.filter((file) => /(^|\/)connectum\/[^/]+\/v1\/options_pb\.ts$/.test(file));
    if (local.length > 0) {
        throw new Error(`gen/ holds generated Connectum option protos the project should import instead: ${local.join(", ")}`);
    }
    const sources = files.map((file) => readFileSync(join(gen, file), "utf8"));
    for (const name of packages) {
        const short = name.slice("@connectum/".length);
        const specifier = `${name}/gen/connectum/${short}/v1/options_pb.js`;
        if (!sources.some((source) => source.includes(`from "${specifier}";`))) {
            throw new Error(`no generated file in gen/ imports ${specifier}`);
        }
        // Resolved from the project directory, the way its generated code resolves it.
        const symbol = `file_connectum_${short}_v1_options`;
        const probe = `const m = await import(${JSON.stringify(specifier)}); if (!m.${symbol}) throw new Error(${JSON.stringify(`${specifier} does not export ${symbol}`)});`;
        run(process.execPath, ["--input-type=module", "-e", probe], target);
    }
}

/** Scaffold, install, typecheck and test one combination. Returns a result record. */
function checkCombo(combo, workdir, pack) {
    const started = process.hrtime.bigint();
    const target = join(workdir, combo.name);
    const fixture = combo.fixture === undefined ? undefined : FIXTURES[combo.fixture];
    try {
        run(process.execPath, [CLI_ENTRY, "init", combo.name, "--package-manager", combo.pm, "--yes", ...combo.args], workdir);
        if (fixture !== undefined) {
            cpSync(fixture.dir, target, { recursive: true });
        }
        // Read before useLocalTarballs rewrites the @connectum/* specs to tarball paths:
        // the slice floor is a property of the manifest `init` wrote.
        const optionImports = optionImportPackages(target);
        if (optionImports.length > 0) {
            assertConnectumSlice(target);
        }
        if (pack) useLocalTarballs(target, combo.pm, pack.tarballs);
        run(combo.pm, ["install"], target);
        if (pack) assertPackedInstall(target, pack.manifests);
        run(combo.pm, ["run", "typecheck"], target);
        run(combo.pm, ["run", "test"], target);
        if (optionImports.length > 0) {
            assertOptionImports(target, optionImports);
        }
        if (fixture !== undefined) {
            // Plain `node`, no flags: the same strip-only load `node src/index.ts` uses.
            run(process.execPath, [fixture.nodeRun], target);
            assertVersionFloors(target);
        }
        return { name: combo.label, combo: combo.name, ok: true, ms: Number((process.hrtime.bigint() - started) / 1_000_000n) };
    } catch (error) {
        return { name: combo.label, combo: combo.name, ok: false, ms: Number((process.hrtime.bigint() - started) / 1_000_000n), error };
    }
}

function main() {
    const opts = parseArgs(process.argv.slice(2));
    if (opts.help) {
        console.log(
            [
                "Usage: pnpm scaffold:check [options]",
                "",
                "  --combo <a,b>    only the named combinations",
                "  --drift          also scaffold from examples@main (the base-drift cell)",
                "  --runtime bun    include the Bun cells (requires bun on PATH)",
                "  --keep           keep the generated projects instead of deleting them",
                "  --pack           install locally packed tarballs of this workspace instead of the published packages",
                "  --pm <npm|pnpm|bun>  run the selected combinations with this package manager (local runs; CI keeps each combination's own)",
                "  --list           print every combination as JSON {name, needsBun} (CI builds its matrix from this)",
                "",
                `Default: ${DEFAULT_COMBOS.map((c) => c.name).join(", ")}`,
                `Opt-in:  ${COMBOS.filter((c) => c.optional)
                    .map((c) => c.name)
                    .join(", ")}`,
            ].join("\n"),
        );
        return;
    }

    // Answered before anything is built: the CI job that reads this only has a checkout.
    // Descriptors, not bare names: the workflow needs per-cell properties (which cells
    // require bun on the runner), and emitting them from the same table that declares
    // them is what stops a new bun combination from silently missing its setup step.
    if (opts.list) {
        console.log(JSON.stringify(COMBOS.map(({ name, needsBun }) => ({ name, needsBun: needsBun === true }))));
        return;
    }

    if (!existsSync(CLI_ENTRY)) {
        console.log("Building @connectum/cli (dist/ is missing)...");
        // Through turbo, not `pnpm --filter ... build`: the CLI build needs the
        // generated reflection code, and only turbo runs `build:proto` before `build`.
        run("pnpm", ["turbo", "run", "build", "--filter", "@connectum/cli"], REPO_ROOT);
    }

    let selected = DEFAULT_COMBOS;
    if (opts.combos) {
        const known = new Set(COMBOS.map((c) => c.name));
        const unknown = opts.combos.filter((n) => !known.has(n));
        if (unknown.length > 0) {
            throw new Error(`scaffold-check: unknown combo(s) ${unknown.join(", ")}. Known: ${[...known].join(", ")}`);
        }
        // Explicit selection reaches the opt-in combinations too — this is how CI runs them.
        selected = COMBOS.filter((c) => opts.combos.includes(c.name));
    } else {
        if (opts.runtime === "bun") selected = [...selected, ...BUN_COMBOS];
        if (opts.drift) selected = [...selected, ...COMBOS.filter((c) => c.name === "base-drift")];
    }

    // `--pm` re-runs a combination with another package manager without adding a
    // combination (and so without adding a CI cell); the label keeps the two apart.
    if (opts.pm !== undefined) {
        if (!["npm", "pnpm", "bun"].includes(opts.pm)) throw new Error(`scaffold-check: --pm must be npm, pnpm or bun (got "${opts.pm}")`);
        selected = selected.map((c) => ({ ...c, pm: opts.pm, label: `${c.name}[${opts.pm}]`, needsBun: c.needsBun === true || opts.pm === "bun" }));
    } else {
        selected = selected.map((c) => ({ ...c, label: c.name }));
    }

    const needsBun = selected.some((c) => c.needsBun === true);
    if (needsBun) {
        try {
            execFileSync("bun", ["--version"], { stdio: "pipe" });
        } catch {
            throw new Error("scaffold-check: the Bun combinations need bun on PATH (https://bun.sh). Install bun, or select other combinations.");
        }
    }

    mkdirSync(SCRATCH_ROOT, { recursive: true });
    const workdir = mkdtempSync(join(SCRATCH_ROOT, "scaffold-check-"));
    const results = [];
    try {
        // A combination marked `pack` always runs against the packed workspace, so a bare
        // run and its CI cell need no flag for it; `--pack` extends that to every
        // selected combination. The workspace is packed once, and only when needed.
        const packedCombos = selected.filter((c) => opts.pack || c.pack === true);
        let pack;
        if (packedCombos.length > 0) {
            console.log(`Building and packing the workspace for ${packedCombos.map((c) => c.label).join(", ")}...`);
            const tarballs = packWorkspace({ repoRoot: REPO_ROOT, dest: join(workdir, "tarballs") });
            const manifests = new Map([...tarballs].filter(([name]) => !TOOL_PACKAGES.has(name)).map(([name, tarball]) => [name, readPackedManifest(tarball)]));
            pack = { tarballs, manifests };
        }
        console.log(`Scaffold check: ${selected.length} combination(s) in ${workdir}\n`);
        for (const combo of selected) {
            const packed = opts.pack || combo.pack === true;
            process.stdout.write(`  ${combo.label.padEnd(20)} ${packed ? "[packed]    " : "[published] "}`);
            const result = checkCombo(combo, workdir, packed ? pack : undefined);
            results.push(result);
            console.log(result.ok ? `ok   (${(result.ms / 1000).toFixed(1)}s)` : `FAIL (${(result.ms / 1000).toFixed(1)}s)`);
        }
    } finally {
        if (opts.keep) {
            console.log(`\nGenerated projects kept in ${workdir}`);
        } else {
            rmSync(workdir, { recursive: true, force: true });
        }
    }

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
        console.log("");
        for (const result of failed) {
            console.log(`--- ${result.name} ---\n${result.error.message}\n`);
        }
        console.log(`${failed.length} of ${results.length} combination(s) failed: ${failed.map((r) => r.name).join(", ")}`);
        if (failed.some((r) => r.combo === "base-drift")) {
            console.log("\nbase-drift failed: the pinned base and examples@main have diverged. Fix the scaffold");
            console.log("fragment, then tag examples and bump DEFAULT_BASE_REF — do not bump the tag alone.");
        }
        process.exitCode = 1;
        return;
    }
    console.log(`\nAll ${results.length} combination(s) passed.`);
}

try {
    main();
} catch (error) {
    // A usage mistake should read as a message, not as a Node stack trace.
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
}
