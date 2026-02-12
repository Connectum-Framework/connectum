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

import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import { fetchFileDescriptorSetBinary, fetchReflectionData } from "../utils/reflection.ts";

/**
 * Options for the proto sync pipeline.
 */
export interface ProtoSyncOptions {
    /** Server URL (e.g., "http://localhost:5000") */
    from: string;
    /** Output directory for generated types */
    out: string;
    /** Path to custom buf.gen.yaml template */
    template?: string;
    /** Show what would be synced without generating */
    dryRun?: boolean;
}

/**
 * Execute the proto sync pipeline.
 *
 * @param options - Proto sync configuration
 */
export async function executeProtoSync(options: ProtoSyncOptions): Promise<void> {
    const { from, out, template, dryRun } = options;

    // Ensure URL has protocol
    const url = from.startsWith("http") ? from : `http://${from}`;

    if (dryRun) {
        await executeDryRun(url, out);
        return;
    }

    await executeFullSync(url, out, template);
}

/**
 * Dry-run mode: connect to server, list services and files, but do not generate code.
 */
async function executeDryRun(url: string, out: string): Promise<void> {
    console.log(`Connecting to ${url}...`);

    const result = await fetchReflectionData(url);

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
async function executeFullSync(url: string, out: string, template?: string): Promise<void> {
    console.log(`Connecting to ${url}...`);

    // Step 1: Fetch FileDescriptorSet as binary
    const binpb = await fetchFileDescriptorSetBinary(url);
    console.log(`Fetched ${binpb.byteLength} bytes of descriptors`);

    // Step 2: Write to temporary file
    const tmpDir = mkdtempSync(join(tmpdir(), "connectum-proto-sync-"));
    const binpbPath = join(tmpDir, "descriptors.binpb");
    writeFileSync(binpbPath, binpb);

    try {
        // Step 3: Run buf generate
        const templateFlag = template ? `--template ${template}` : "";
        const command = `buf generate ${binpbPath} --output ${out} ${templateFlag}`.trim();

        console.log(`Running: ${command}`);
        execSync(command, { stdio: "inherit" });

        console.log(`Proto types synced to ${out}`);
    } finally {
        // Step 4: Cleanup temporary files
        rmSync(tmpDir, { recursive: true, force: true });
    }
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
        });
    },
});
