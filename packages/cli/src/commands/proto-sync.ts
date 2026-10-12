/**
 * Proto sync command
 *
 * Syncs proto types from a running Connectum server via gRPC Reflection.
 *
 * Pipeline:
 * 1. Connect to server via ServerReflectionClient
 * 2. Discover services and build FileRegistry
 * 3. Serialize as FileDescriptorSet binary (.binpb)
 * 4. Run `buf generate` with .binpb input
 *
 * @module commands/proto-sync
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import { DEFAULT_REFLECTION_TIMEOUT_MS, fetchFileDescriptorSetBinary, fetchReflectionData, isValidReflectionTimeout, MAX_REFLECTION_TIMEOUT_MS } from "../utils/reflection.ts";

/**
 * Options for the proto sync pipeline.
 */
export interface ProtoSyncOptions {
    /** Server URL (e.g., "http://localhost:5000") */
    from: string;
    /** Output directory for generated types */
    out: string;
    /** Path to custom buf.gen.yaml template */
    template?: string | undefined;
    /** Show what would be synced without generating */
    dryRun?: boolean;
    /** Time limit of each reflection request in ms (positive integer; default 10 000). */
    timeoutMs?: number | undefined;
}

/**
 * Fetch service descriptors from a running server and generate client types with `buf`.
 *
 * With `dryRun: true`, this only lists the services and proto files that would be
 * synced. A full sync passes the fetched descriptor set to `buf generate` and
 * removes its temporary descriptor file after the command finishes.
 *
 * @param options - Proto sync configuration
 */
export async function executeProtoSync(options: ProtoSyncOptions): Promise<void> {
    const { from, out, template, dryRun } = options;
    const timeoutMs = options.timeoutMs ?? DEFAULT_REFLECTION_TIMEOUT_MS;
    if (!isValidReflectionTimeout(timeoutMs)) {
        throw new Error(`--timeout must be a positive integer number of milliseconds (at most ${MAX_REFLECTION_TIMEOUT_MS}), got ${timeoutMs}.`);
    }

    // Ensure URL has protocol
    const url = from.startsWith("http") ? from : `http://${from}`;

    if (dryRun) {
        await executeDryRun(url, out, timeoutMs);
        return;
    }

    await executeFullSync(url, out, timeoutMs, template);
}

/**
 * Dry-run mode: connect to server, list services and files, but do not generate code.
 */
async function executeDryRun(url: string, out: string, timeoutMs: number): Promise<void> {
    console.log(`Connecting to ${url}...`);

    const result = await fetchReflectionData(url, { timeoutMs });

    console.log(`Connected to ${url}`);
    console.log("");
    console.log("Services:");
    for (const service of result.services) {
        console.log(`  - ${service}`);
    }
    console.log("");
    console.log("Files:");
    for (const fileName of result.fileNames) {
        console.log(`  - ${fileName}`);
    }
    console.log("");
    console.log(`Would generate to: ${out}`);
}

/**
 * Full sync: fetch descriptors, write .binpb, run buf generate.
 */
async function executeFullSync(url: string, out: string, timeoutMs: number, template?: string): Promise<void> {
    console.log(`Connecting to ${url}...`);

    // Step 1: Fetch FileDescriptorSet as binary
    const binpb = await fetchFileDescriptorSetBinary(url, { timeoutMs });
    console.log(`Fetched ${binpb.byteLength} bytes of descriptors`);

    // Step 2: Write to temporary file
    const tmpDir = mkdtempSync(join(tmpdir(), "connectum-proto-sync-"));
    const binpbPath = join(tmpDir, "descriptors.binpb");
    writeFileSync(binpbPath, binpb);

    try {
        // Step 3: Run buf generate (execFileSync prevents command injection)
        const args = ["generate", binpbPath, "--output", out];
        if (template) {
            args.push("--template", template);
        }

        console.log(`Running: buf ${args.join(" ")}`);
        execFileSync("buf", args, { stdio: "inherit" });

        console.log(`Proto types synced to ${out}`);
    } finally {
        // Step 4: Cleanup temporary files
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

/**
 * Parse the `--timeout` value. Anything but a plain positive integer (`0`, `-5`, `1.5`,
 * `abc`, `10s`) is refused rather than coerced, so a typo cannot silently become "no limit".
 */
export function parseTimeoutOption(raw: string | undefined): number | undefined {
    if (raw === undefined) {
        return undefined;
    }
    if (!/^[1-9]\d*$/.test(raw)) {
        throw new Error(`--timeout must be a positive integer number of milliseconds (at most ${MAX_REFLECTION_TIMEOUT_MS}), got "${raw}".`);
    }
    return Number(raw);
}

/**
 * citty command definition for `connectum proto sync`.
 */
export const protoSyncCommand = defineCommand({
    meta: {
        name: "sync",
        description: "Sync proto types from a running Connectum server via gRPC Reflection",
    },
    args: {
        from: {
            type: "string",
            description: "Server address (e.g., localhost:5000 or http://localhost:5000)",
            required: true,
        },
        out: {
            type: "string",
            description: "Output directory for generated types",
            required: true,
        },
        template: {
            type: "string",
            description: "Path to custom buf.gen.yaml template",
        },
        timeout: {
            type: "string",
            description: `Time limit of each reflection request in milliseconds (positive integer; default: ${DEFAULT_REFLECTION_TIMEOUT_MS})`,
        },
        "dry-run": {
            type: "boolean",
            description: "Show what would be synced without generating code",
            default: false,
        },
    },
    async run({ args }) {
        await executeProtoSync({
            from: args.from,
            out: args.out,
            template: args.template,
            dryRun: args["dry-run"],
            timeoutMs: parseTimeoutOption(args.timeout),
        });
    },
});
