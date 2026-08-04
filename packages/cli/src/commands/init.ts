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

import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import { resolveConfig } from "../scaffold/config.ts";
import type { CloneFn } from "../scaffold/fetchBase.ts";
import { DEFAULT_BASE_REF, fetchBase, readTree } from "../scaffold/fetchBase.ts";
import { collectConfig } from "../scaffold/prompts.ts";
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
    /** Comma-separated resilience interceptors (timeout,bulkhead,circuitBreaker,retry,fallback). */
    resilience?: string | undefined;
    /** Include the gRPC health protocol (default true; pass --no-healthcheck to omit). */
    healthcheck?: boolean | undefined;
    /** Include gRPC reflection (default true; pass --no-reflection to omit). */
    reflection?: boolean | undefined;
    /** Add the service catalog (typed ctx.call). */
    catalog?: boolean | undefined;
    /** Non-interactive mode (skip the TUI; use flags/defaults). */
    yes?: boolean | undefined;
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
    const raw = await collectConfig({
        name: options.name,
        runtime: options.runtime,
        packageManager: options.packageManager,
        nodeExec: options.nodeExec,
        sample: options.sample,
        otel: options.otel,
        events: options.events,
        auth: options.auth,
        resilience: options.resilience,
        healthcheck: options.healthcheck,
        reflection: options.reflection,
        catalog: options.catalog,
        yes: options.yes,
    });
    const config = resolveConfig(raw);

    const targetDir = resolve(process.cwd(), config.name);
    if (existsSync(targetDir)) {
        // Guard before readdirSync: a path that exists but is a file would throw a raw ENOTDIR.
        if (!statSync(targetDir).isDirectory()) {
            throw new Error(`connectum init: "${config.name}" already exists and is not a directory.`);
        }
        if (!options.force && readdirSync(targetDir).length > 0) {
            throw new Error(`connectum init: target directory "${config.name}" already exists and is not empty (use --force to overwrite).`);
        }
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
            required: false,
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
            description: "Emit a runnable sample service (default: true)",
        },
        otel: {
            type: "boolean",
            description: "Add OpenTelemetry instrumentation",
        },
        events: {
            type: "string",
            description: "Add EventBus with an adapter: nats | kafka | redpanda | redis | amqp",
        },
        auth: {
            type: "boolean",
            description: "Add JWT authentication + proto authorization",
        },
        resilience: {
            type: "string",
            description: "Enable resilience interceptors (comma list: timeout,bulkhead,circuitBreaker,retry,fallback)",
        },
        healthcheck: {
            type: "boolean",
            description: "Include the gRPC health protocol (default: true)",
        },
        reflection: {
            type: "boolean",
            description: "Include gRPC server reflection (default: true)",
        },
        catalog: {
            type: "boolean",
            description: "Add the service catalog (typed ctx.call / ctx.stream)",
        },
        yes: {
            type: "boolean",
            alias: "y",
            description: "Non-interactive mode (skip prompts; use flags/defaults)",
            default: false,
        },
        force: {
            type: "boolean",
            description: "Overwrite existing files",
            default: false,
        },
        ref: {
            type: "string",
            description: `Base example git ref to fetch (advanced; default: ${DEFAULT_BASE_REF})`,
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
            resilience: args.resilience,
            healthcheck: args.healthcheck,
            reflection: args.reflection,
            catalog: args.catalog,
            yes: args.yes,
            force: args.force,
            ref: args.ref,
        });
    },
});
