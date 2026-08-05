#!/usr/bin/env node
/**
 * Local reproduction of the `cli-scaffold-matrix` CI gate.
 *
 * For each named module combination: scaffold a project with the freshly built CLI,
 * install it, then run `typecheck` (which runs `buf generate` first) and `test`. A
 * broken module fragment fails here instead of in CI — or, worse, in a user's `init`.
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
 * Usage:
 *   pnpm scaffold:check                     # the default combos, pinned base
 *   pnpm scaffold:check --combo auth,otel   # only the named combos
 *   pnpm scaffold:check --drift             # also run the kitchen sink against examples@main
 *   pnpm scaffold:check --keep              # keep the generated projects for inspection
 *   pnpm scaffold:check --runtime bun       # also run the Bun cell (requires bun on PATH)
 *   pnpm scaffold:check --list              # combination names as JSON (CI builds its matrix from this)
 *
 * Exit code is non-zero if any combination fails; a summary table is always printed.
 *
 * @module scripts/scaffold-check
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_ENTRY = join(REPO_ROOT, "packages/cli/dist/index.js");
/** Scratch root: the repo's gitignored `.tmp/`, so `--keep` output is easy to find. */
const SCRATCH_ROOT = join(REPO_ROOT, ".tmp");

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
 */
const COMBOS = [
    { name: "base-node-pnpm", pm: "pnpm", args: [] },
    { name: "base-node-npm", pm: "npm", args: [] },
    { name: "otel", pm: "npm", args: ["--otel"] },
    { name: "events-nats", pm: "npm", args: ["--events", "nats"] },
    { name: "auth", pm: "npm", args: ["--auth"] },
    { name: "catalog", pm: "npm", args: ["--catalog"] },
    { name: "kitchen-sink", pm: "npm", args: ["--otel", "--events", "nats", "--auth", "--catalog", "--resilience", "retry,timeout"] },
    { name: "bun", pm: "npm", args: ["--runtime", "bun"], optional: true, needsBun: true },
    // The two axes are independent, so both crossings are worth a cell: the one above
    // runs a Bun-runtime project installed with npm, this one installs with bun and
    // runs on Node. `bun install` lays out an ordinary node_modules either way.
    { name: "bun-pm", pm: "bun", args: [], optional: true, needsBun: true },
    { name: "base-drift", pm: "npm", args: ["--ref", "main", "--otel", "--events", "nats", "--auth", "--catalog"], optional: true },
];

/** Combinations that need `bun` on PATH — the only selector for them, locally and in CI. */
const BUN_COMBOS = COMBOS.filter((c) => c.needsBun === true);

/** Combinations a bare `pnpm scaffold:check` runs. */
const DEFAULT_COMBOS = COMBOS.filter((c) => c.optional !== true);

/** Parse `--flag value` / `--flag` arguments without pulling in a dependency. */
function parseArgs(argv) {
    const opts = { combos: undefined, drift: false, keep: false, list: false, runtime: undefined };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === "--drift") opts.drift = true;
        else if (arg === "--keep") opts.keep = true;
        else if (arg === "--list") opts.list = true;
        else if (arg === "--combo") opts.combos = (argv[++i] ?? "").split(",").filter(Boolean);
        else if (arg === "--runtime") opts.runtime = argv[++i];
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

/** Scaffold, install, typecheck and test one combination. Returns a result record. */
function checkCombo(combo, workdir) {
    const started = process.hrtime.bigint();
    const target = join(workdir, combo.name);
    try {
        run(process.execPath, [CLI_ENTRY, "init", combo.name, "--package-manager", combo.pm, "--yes", ...combo.args], workdir);
        run(combo.pm, ["install"], target);
        run(combo.pm, ["run", "typecheck"], target);
        run(combo.pm, ["run", "test"], target);
        return { name: combo.name, ok: true, ms: Number((process.hrtime.bigint() - started) / 1_000_000n) };
    } catch (error) {
        return { name: combo.name, ok: false, ms: Number((process.hrtime.bigint() - started) / 1_000_000n), error };
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
        run("pnpm", ["--filter", "@connectum/cli", "build"], REPO_ROOT);
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
    console.log(`Scaffold check: ${selected.length} combination(s) in ${workdir}\n`);

    const results = [];
    try {
        for (const combo of selected) {
            process.stdout.write(`  ${combo.name.padEnd(16)} `);
            const result = checkCombo(combo, workdir);
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
        if (failed.some((r) => r.name === "base-drift")) {
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
