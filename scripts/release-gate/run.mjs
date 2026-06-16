// Release publish-boundary gate — orchestrator.
//
// Validates the framework AS A THIRD-PARTY CONSUMER experiences it, against the
// PACKED artifacts (never src/ or in-workspace dist/). Sets up a throwaway
// consumer from ./fixture, installs every published @connectum/* package from
// either a pkg-pr-new preview (pinned to a commit SHA) or local pnpm-packed
// tarballs, generates the service catalog, then runs four publish-boundary
// checks + the behavioral smoke.
//
// Usage:
//   node scripts/release-gate/run.mjs --mode preview --ref <sha>   # pkg-pr-new
//   node scripts/release-gate/run.mjs --mode pack                  # local tarballs
//
// Exit code is non-zero if any check fails.

import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..");
const FIXTURE = join(HERE, "fixture");
const WORK = join(REPO, ".gate-work");

// Published packages (order irrelevant). Keep in sync with packages/*.
const PKGS = [
    "core",
    "auth",
    "interceptors",
    "healthcheck",
    "protoc-gen-catalog",
    "reflection",
    "cli",
    "otel",
    "testing",
    "test-fixtures",
    "events",
    "events-nats",
    "events-kafka",
    "events-redis",
    "events-amqp",
];

function arg(name) {
    const i = process.argv.indexOf(`--${name}`);
    return i >= 0 ? process.argv[i + 1] : undefined;
}
const mode = arg("mode") ?? "preview";
const ref = arg("ref");

function sh(cmd, args, opts = {}) {
    const r = spawnSync(cmd, args, { stdio: "inherit", cwd: WORK, ...opts });
    return r.status ?? 1;
}
function die(msg) {
    console.error(`release-gate: ${msg}`);
    process.exit(1);
}

// --- 1. fresh workdir from the fixture ---
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(FIXTURE, WORK, { recursive: true });

// --- 2. overrides: every @connectum/* → packed artifact ---
let target;
let overrideLines;
if (mode === "preview") {
    if (!ref) die("--mode preview requires --ref <commit-sha> (pkg-pr-new is pinned to a SHA, never a moving tag)");
    target = `pkg-pr-new @${ref}`;
    overrideLines = PKGS.map((p) => `  '@connectum/${p}': 'https://pkg.pr.new/Connectum-Framework/connectum/@connectum/${p}@${ref}'`);
} else if (mode === "pack") {
    target = "local pnpm pack";
    const tarDir = join(WORK, "tarballs");
    mkdirSync(tarDir, { recursive: true });
    if (sh("pnpm", ["-w", "build"], { cwd: REPO })) die("workspace build failed");
    for (const p of PKGS) {
        if (sh("pnpm", ["pack", "--pack-destination", tarDir], { cwd: join(REPO, "packages", p) })) die(`pnpm pack failed for ${p}`);
    }
    const tarballs = readdirSync(tarDir);
    const find = (p) => {
        const hit = tarballs.find((f) => f.startsWith(`connectum-${p}-`));
        if (!hit) die(`no tarball produced for @connectum/${p}`);
        return join(tarDir, hit);
    };
    overrideLines = PKGS.map((p) => `  '@connectum/${p}': 'file:${find(p)}'`);
} else {
    die(`unknown --mode '${mode}' (expected preview|pack)`);
}

// pkg-pr-new tarballs cross-reference each other via pkg.pr.new URLs (exotic
// subdeps), which pnpm 11 blocks by default; buf downloads its binary in a
// build script. Allow both for this isolated consumer.
const ws = [
    "packages:",
    "  - '.'",
    "blockExoticSubdeps: false",
    "allowBuilds:",
    "  '@bufbuild/buf': true",
    "  esbuild: true",
    "  protobufjs: true",
    "overrides:",
    ...overrideLines,
    "",
].join("\n");
writeFileSync(join(WORK, "pnpm-workspace.yaml"), ws);
console.log(`release-gate: target = ${target}`);

// --- 3. install + generate the catalog (codegen check) ---
if (sh("pnpm", ["install", "--no-frozen-lockfile"])) die("consumer install failed");
if (sh("pnpm", ["exec", "buf", "generate"])) die("catalog codegen (buf generate) failed");

// --- 4. run the checks (cwd = workdir, so imports resolve from the packed install) ---
const env = { ...process.env, GATE_TARGET: target };
const checks = [
    ["export-map + .d.ts graph (oracle)", ["node", "checks/oracle.mjs"]],
    ["value-export completeness", ["node", "checks/completeness.mjs"]],
    ["runtime importability", ["node", "checks/runtime-import.mjs"]],
    ["behavioral smoke", ["node", "src/smoke.ts"]],
];
const failed = [];
for (const [label, [cmd, ...args]] of checks) {
    console.log(`\n=== ${label} ===`);
    if (sh(cmd, args, { env })) failed.push(label);
}

// --- 5. verdict ---
console.log(`\n=== release-gate verdict (${target}) ===`);
if (failed.length === 0) {
    console.log("PASS — publish boundary + behavioral smoke green");
    process.exit(0);
}
console.log(`FAIL — ${failed.length} check(s) failed: ${failed.join(", ")}`);
process.exit(1);
