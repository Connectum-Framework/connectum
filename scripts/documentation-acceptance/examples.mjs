/**
 * Validate standalone example consumers against all locally packed candidate
 * Connectum packages. Example projects are copied into an ignored .tmp folder;
 * their source manifests, lockfiles, and generated output remain untouched.
 *
 * Usage:
 *   node scripts/documentation-acceptance/examples.mjs \
 *     --examples ../examples \
 *     --candidate-dir .tmp/documentation-acceptance-<id>/tarballs \
 *     --projects getting-started,hris,car-sharing,with-custom-interceptor,with-events-amqp,with-events-dlq,with-events-kafka,with-events-redpanda,with-events-valkey \
 *     --keep
 */

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageNames = [
    "auth",
    "cli",
    "core",
    "events",
    "events-amqp",
    "events-kafka",
    "events-nats",
    "events-redis",
    "healthcheck",
    "interceptors",
    "otel",
    "protoc-gen-catalog",
    "reflection",
    "test-fixtures",
    "testing",
];
const defaultProjects = [
    "getting-started",
    "hris",
    "car-sharing",
    "with-custom-interceptor",
    "with-events-amqp",
    "with-events-dlq",
    "with-events-kafka",
    "with-events-redpanda",
    "with-events-valkey",
];
const brokerProjects = new Map([
    ["with-events-amqp", { service: ["rabbitmq"], variable: "AMQP_URL", address: "amqp://guest:guest@localhost:5672" }],
    ["with-events-dlq", { service: ["nats"], variable: "NATS_URL", address: "nats://localhost:4222" }],
    ["with-events-kafka", { service: ["kafka"], initialize: ["kafka-init"], variable: "KAFKA_BROKERS", address: "localhost:9092" }],
    ["with-events-redpanda", { service: ["redpanda", "console"], variable: "REDPANDA_BROKERS", address: "localhost:9092" }],
    ["with-events-valkey", { service: ["valkey"], variable: "REDIS_URL", address: "redis://localhost:6379" }],
]);

function requiredOption(name) {
    const index = process.argv.indexOf(`--${name}`);
    if (index < 0 || !process.argv[index + 1] || process.argv[index + 1].startsWith("--")) {
        throw new Error(`--${name} requires a value`);
    }
    return resolve(process.argv[index + 1]);
}

const examples = requiredOption("examples");
const candidateDir = requiredOption("candidate-dir");
const projectsIndex = process.argv.indexOf("--projects");
const projects = projectsIndex < 0 ? defaultProjects : process.argv[projectsIndex + 1]?.split(",").filter(Boolean);
if (!projects?.length || projects.some((name) => !defaultProjects.includes(name))) {
    throw new Error(`--projects must be a comma-separated subset of: ${defaultProjects.join(",")}`);
}
const keep = process.argv.includes("--keep");
const outcomes = [];
const tarballs = new Map();

for (const name of packageNames) {
    const prefix = `connectum-${name}-`;
    const exactName = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\d+\\.\\d+\\.\\d+(?:[-+][0-9A-Za-z.-]+)?\\.tgz$`);
    const files = readdirSync(candidateDir).filter((file) => exactName.test(file));
    if (files.length !== 1) throw new Error(`${candidateDir}: expected exactly one ${prefix}<version>.tgz, found ${files.length}`);
    tarballs.set(`@connectum/${name}`, join(candidateDir, files[0]));
}

mkdirSync(join(repo, ".tmp"), { recursive: true });
const work = mkdtempSync(join(repo, ".tmp/documentation-examples-"));
const runId = basename(work).slice("documentation-examples-".length).toLowerCase();
const children = new Set();
const composeProjects = new Map();

function environment(extra = {}) {
    const env = { ...process.env, ...extra };
    delete env.CONNECTUM_LOCAL;
    delete env.PNPM_CONFIG_PNPMFILE;
    delete env.pnpm_config_pnpmfile;
    return env;
}

function execute(command, args, cwd, { timeout = 600_000, env = environment() } = {}) {
    console.log(`example-acceptance: ${command} ${args.join(" ")} (cwd=${cwd})`);
    const result = spawnSync(command, args, { cwd, env, stdio: "inherit", timeout, maxBuffer: 8 * 1024 * 1024, shell: false });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? result.signal}`);
}

function candidateOverrides(projectDir) {
    const workspaceFile = join(projectDir, "pnpm-workspace.yaml");
    let source = existsSync(workspaceFile) ? readFileSync(workspaceFile, "utf8") : "";
    const overrides = [...tarballs].map(([name, path]) => `  '${name}': 'file:${path.replaceAll("'", "''")}'`).join("\n");
    if (/^overrides:\s*$/m.test(source)) {
        source = source.replace(/^overrides:\s*$/m, `overrides:\n${overrides}`);
    } else {
        source = `${source.trimEnd()}\n\noverrides:\n${overrides}\n`;
    }
    writeFileSync(workspaceFile, source);
}

function verifyCandidateLinks(projectDir, phase) {
    const scope = join(projectDir, "node_modules", "@connectum");
    if (!existsSync(scope)) throw new Error(`${projectDir}: @connectum dependencies missing ${phase}`);
    const installed = readdirSync(scope);
    if (installed.length === 0) throw new Error(`${projectDir}: no @connectum packages installed ${phase}`);
    const resolved = installed.map((name) => {
        const path = realpathSync(join(scope, name));
        if (!path.includes("@file+")) throw new Error(`${projectDir}: @connectum/${name} resolved outside candidate tarballs ${phase}: ${path}`);
        console.log(`candidate ${phase}: @connectum/${name} -> ${path}`);
        return name;
    });
    return resolved;
}

function copyProject(source, target) {
    cpSync(source, target, {
        recursive: true,
        filter: (path) => {
            const name = path.slice(path.lastIndexOf("/") + 1);
            if (name === ".env" || (name.startsWith(".env.") && name !== ".env.example")) return false;
            return !/(?:^|\/)(?:node_modules|gen|\.git|\.tmp)(?:\/|$)/.test(path);
        },
    });
}

function startProcess(command, args, cwd, env) {
    console.log(`example-acceptance: start ${command} ${args.join(" ")} (cwd=${cwd})`);
    const child = spawn(command, args, { cwd, env, stdio: "inherit", shell: false, detached: true });
    children.add(child);
    return child;
}

function signalProcessTree(child, signal) {
    if (child.pid === undefined) return;
    try {
        process.kill(-child.pid, signal);
    } catch (error) {
        if (error.code !== "ESRCH") throw error;
    }
}

function waitForExit(child, timeoutMs = 10_000) {
    return new Promise((resolveExit) => {
        if (child.exitCode !== null || child.signalCode !== null) {
            children.delete(child);
            resolveExit();
            return;
        }
        const timer = setTimeout(() => {
            signalProcessTree(child, "SIGTERM");
            const force = setTimeout(() => signalProcessTree(child, "SIGKILL"), 2_000);
            force.unref();
        }, timeoutMs);
        child.once("exit", () => {
            clearTimeout(timer);
            children.delete(child);
            resolveExit();
        });
    });
}

async function waitForHttp(child, url) {
    const deadline = Date.now() + 60_000;
    let lastError;
    while (Date.now() < deadline) {
        if (child.exitCode !== null || child.signalCode !== null) throw new Error(`service exited before readiness: ${url}`);
        try {
            const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1_000) });
            if (response.ok) return;
            lastError = new Error(`${url}/healthz returned ${response.status}`);
        } catch (error) {
            lastError = error;
        }
        await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    throw new Error(`timed out waiting for ${url}/healthz: ${lastError}`);
}

async function runBrokerExample(projectDir, name) {
    const broker = brokerProjects.get(name);
    assert.ok(broker, `${name} must have a broker fixture`);
    const composeFile = join(projectDir, "docker-compose.yml");
    assert.ok(existsSync(composeFile), `${name} must contain its documented docker-compose.yml`);
    const composeName = `docsaccept-${runId}-${name.replaceAll("_", "-")}`;
    composeProjects.set(name, { projectDir, composeName });
    execute("docker", ["compose", "--project-name", composeName, "-f", composeFile, "up", "-d", "--wait", ...broker.service], projectDir);
    if (broker.initialize) {
        execute("docker", ["compose", "--project-name", composeName, "-f", composeFile, "run", "--rm", ...broker.initialize], projectDir);
    }
    const env = environment({ [broker.variable]: broker.address });
    const order = startProcess("pnpm", ["run", "start:order"], projectDir, env);
    const inventory = startProcess("pnpm", ["run", "start:inventory"], projectDir, env);
    try {
        await Promise.all([waitForHttp(order, "http://127.0.0.1:5001"), waitForHttp(inventory, "http://127.0.0.1:5002")]);
        verifyCandidateLinks(projectDir, "after service start");
        execute("pnpm", ["run", "test:e2e"], projectDir, { env });
        outcomes.push({ project: name, phase: "test:e2e", result: "passed" });
    } finally {
        signalProcessTree(order, "SIGINT");
        signalProcessTree(inventory, "SIGINT");
        await Promise.all([waitForExit(order), waitForExit(inventory)]);
        execute("docker", ["compose", "--project-name", composeName, "-f", composeFile, "down", "--remove-orphans", "--volumes"], projectDir);
        composeProjects.delete(name);
    }
}

async function cleanup() {
    for (const child of children) signalProcessTree(child, "SIGINT");
    await Promise.all([...children].map((child) => waitForExit(child)));
    for (const { projectDir, composeName } of composeProjects.values()) {
        const composeFile = join(projectDir, "docker-compose.yml");
        const result = spawnSync("docker", ["compose", "--project-name", composeName, "-f", composeFile, "down", "--remove-orphans", "--volumes"], {
            cwd: projectDir,
            env: environment(),
            stdio: "inherit",
            shell: false,
        });
        if (result.error || result.status !== 0) console.error(`cleanup failed for owned Compose project ${composeName}`);
    }
    if (keep) console.log(`example-acceptance: retained ${work}`);
    else rmSync(work, { recursive: true, force: true });
}

try {
    for (const name of projects) {
        const source = join(examples, name);
        assert.ok(existsSync(join(source, "package.json")), `${source}: package.json missing`);
        const projectDir = join(work, name);
        mkdirSync(projectDir, { recursive: true });
        copyProject(source, projectDir);
        candidateOverrides(projectDir);

        execute("pnpm", ["install", "--no-frozen-lockfile"], projectDir);
        verifyCandidateLinks(projectDir, "after install");
        execute("pnpm", ["run", "build:proto"], projectDir);
        execute("pnpm", ["run", "typecheck"], projectDir);
        verifyCandidateLinks(projectDir, "after generation and typecheck");
        outcomes.push({ project: name, phase: "typecheck", result: "passed" });

        if (brokerProjects.has(name)) {
            await runBrokerExample(projectDir, name);
        } else {
            execute("pnpm", ["test"], projectDir);
            verifyCandidateLinks(projectDir, "after tests");
            outcomes.push({ project: name, phase: "test", result: "passed" });
        }
    }
    console.log(JSON.stringify({ work, projects, outcomes }, null, 2));
} finally {
    await cleanup();
}
