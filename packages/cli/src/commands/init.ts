/**
 * `connectum init` — scaffold a new standalone Connectum project.
 *
 * Pipeline (OpenSpec change cli-scaffolding, Phase 1):
 * 1. Resolve flags into a validated {@link ScaffoldConfig}.
 * 2. Fetch the source-of-truth base (`getting-started`) into a temp dir (D-13).
 * 3. Transform it (de-monorepo, runtime/PM adjustments, lifecycle-fix, in-process
 *    e2e test) into the final project file map (pure).
 * 4. Emit into the target directory (refuse-to-clobber).
 *
 * Interactive module selection (TUI + fragments) lands in Phase 2. Dependency
 * install / `git init` are left to the developer (printed as next steps) for now.
 *
 * @module commands/init
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import { resolveConfig } from "../scaffold/config.ts";
import type { CloneFn } from "../scaffold/fetchBase.ts";
import { fetchBase, readTree } from "../scaffold/fetchBase.ts";
import { transformBase } from "../scaffold/transform.ts";
import { emitFiles } from "../utils/emit.ts";

/**
 * Options for the `init` pipeline.
 */
export interface InitOptions {
    /** Project name / target directory. */
    name?: string | undefined;
    /** Target runtime: `node` (default) or `bun`. */
    runtime?: string | undefined;
    /** Package manager: `pnpm` (default) or `npm`. */
    packageManager?: string | undefined;
    /** Node execution model: `raw` (default) or `tsx` (Node runtime only). */
    nodeExec?: string | undefined;
    /** Emit a runnable sample service (default true) or config-only. */
    sample?: boolean | undefined;
    /** Enable the OpenTelemetry module. */
    otel?: boolean | undefined;
    /** Enable the EventBus module with the given adapter (nats|kafka|redpanda|redis|amqp). */
    events?: string | undefined;
    /** Enable the auth module (JWT + proto authorization). */
    auth?: boolean | undefined;
    /** Base git ref to fetch (advanced; defaults to the pinned example ref). */
    ref?: string | undefined;
    /** Overwrite existing files instead of refusing. */
    force?: boolean | undefined;
    /** Injected clone function (tests supply a local-copy stub; production uses tiged). */
    clone?: CloneFn | undefined;
}

/**
 * Execute the `init` pipeline.
 *
 * @param options - Init configuration
 */
export async function executeInit(options: InitOptions): Promise<void> {
    const config = resolveConfig({
        name: options.name,
        runtime: options.runtime,
        packageManager: options.packageManager,
        nodeExec: options.nodeExec,
        sample: options.sample,
        otel: options.otel,
        events: options.events,
        auth: options.auth,
    });

    const targetDir = resolve(process.cwd(), config.name);
    if (!options.force && existsSync(targetDir) && readdirSync(targetDir).length > 0) {
        throw new Error(`connectum init: target directory "${config.name}" already exists and is not empty (use --force to overwrite).`);
    }

    const tmp = mkdtempSync(join(tmpdir(), "connectum-init-base-"));
    try {
        console.log(`Fetching base project (${config.runtime}/${config.packageManager})...`);
        await fetchBase(tmp, { ref: options.ref, clone: options.clone });

        const baseFiles = readTree(tmp);
        const finalFiles = transformBase(baseFiles, config);
        const result = emitFiles(targetDir, finalFiles, { force: options.force ?? false });

        console.log(`Scaffolded ${result.written.length} files into ${config.name}/`);
        if (result.skipped.length > 0) {
            console.log(`Skipped ${result.skipped.length} existing file(s): ${result.skipped.join(", ")}`);
        }
        console.log("");
        console.log("Next steps:");
        console.log(`  cd ${config.name}`);
        console.log(`  ${config.packageManager} install`);
        console.log(`  ${config.packageManager} run start`);
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

/**
 * citty command definition for `connectum init`.
 */
export const initCommand = defineCommand({
    meta: {
        name: "init",
        description: "Scaffold a new Connectum project",
    },
    args: {
        name: {
            type: "positional",
            description: "Project name / target directory",
            required: true,
        },
        runtime: {
            type: "string",
            description: "Target runtime: node (default) or bun",
        },
        "package-manager": {
            type: "string",
            description: "Package manager: pnpm (default) or npm",
        },
        "node-exec": {
            type: "string",
            description: "Node execution model: raw (default, Node >=25.2) or tsx (Node >=22.13)",
        },
        sample: {
            type: "boolean",
            description: "Emit a runnable sample service",
            default: true,
        },
        otel: {
            type: "boolean",
            description: "Add OpenTelemetry instrumentation",
            default: false,
        },
        events: {
            type: "string",
            description: "Add EventBus with an adapter: nats | kafka | redpanda | redis | amqp",
        },
        auth: {
            type: "boolean",
            description: "Add JWT authentication + proto authorization",
            default: false,
        },
        force: {
            type: "boolean",
            description: "Overwrite existing files",
            default: false,
        },
    },
    async run({ args }) {
        await executeInit({
            name: args.name,
            runtime: args.runtime,
            packageManager: args["package-manager"],
            nodeExec: args["node-exec"],
            sample: args.sample,
            otel: args.otel,
            events: args.events,
            auth: args.auth,
            force: args.force,
        });
    },
});
