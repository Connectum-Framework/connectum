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
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineCommand } from "citty";
import { CliError, runReported } from "../utils/cliError.ts";
import { assertKnownFlags } from "../utils/flags.ts";
import { DEFAULT_REFLECTION_TIMEOUT_MS, fetchFileDescriptorSetBinary, fetchReflectionData, isValidReflectionTimeout, MAX_REFLECTION_TIMEOUT_MS } from "../utils/reflection.ts";
import { describeReflectionFailure } from "../utils/reflectionFailure.ts";

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

/** Address that already is an `http` or `https` URL. Scheme names are case-insensitive (RFC 3986 section 3.1). */
const HTTP_URL_PATTERN = /^https?:\/\//i;

/** Address that starts with some other `<scheme>://`; captures the scheme name. Anchored and bounded: no backtracking on hostile input. */
const FOREIGN_SCHEME_PATTERN = /^([a-z][a-z0-9+.-]*):\/\//i;

/**
 * Turn the `--from` value into the URL that reflection requests are sent to.
 *
 * An address starting with `http://` or `https://` (any letter case) is returned exactly as
 * typed. An address that carries any other `<scheme>://` is refused, because the command
 * speaks HTTP/2 over `http` and `https` only and passing it on would end in a resolver error
 * naming the wrong host. Every other address is a bare `host:port` and gets `http://` in
 * front of it, whatever letters its host name starts with (`httpbin.local:5000` included).
 *
 * The result must parse as a URL; an empty address and one that does not (`local host:5000`) are
 * refused here, naming the value, instead of surfacing as `Invalid URL` from deep inside the client.
 *
 * @param from - Raw `--from` value
 * @returns URL for the reflection client
 * @throws CliError naming the scheme and the accepted forms when the address carries a non-HTTP
 *   scheme, and naming the value when the address is empty or not a URL
 */
export function normalizeServerUrl(from: string): string {
    if (from.trim() === "") {
        throw new CliError("--from must not be empty. Use host:port, http://... or https://...");
    }
    let url: string;
    if (HTTP_URL_PATTERN.test(from)) {
        url = from;
    } else {
        const foreign = FOREIGN_SCHEME_PATTERN.exec(from);
        if (foreign !== null) {
            throw new CliError(`--from scheme "${foreign[1]}" is not supported. Use host:port, http://... or https://...; got "${from}".`);
        }
        url = `http://${from}`;
    }
    if (!URL.canParse(url)) {
        throw new CliError(`--from "${from}" is not a valid server address. Use host:port, http://... or https://...`);
    }
    return url;
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
        throw new CliError(`--timeout must be a positive integer number of milliseconds (at most ${MAX_REFLECTION_TIMEOUT_MS}), got ${timeoutMs}.`);
    }

    // Resolved before the dry-run/full-sync split, so a refused address produces no output,
    // no connection and no temporary directory.
    const url = normalizeServerUrl(from);

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

    const result = await fetchReflectionData(url, { timeoutMs }).catch((error: unknown) => {
        throw describeReflectionFailure(url, error);
    });

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

/** Whether `path` names an existing regular file (a directory or a missing path is not one). */
function isExistingFile(path: string): boolean {
    try {
        return statSync(path).isFile();
    } catch {
        return false;
    }
}

/**
 * Words a failed `buf generate`. buf prints its own diagnostic straight to the terminal, so a
 * non-zero exit needs only to be named; a missing binary has printed nothing and needs a sentence.
 * Anything else (no process could be started for another reason) is returned unchanged.
 */
function describeBufFailure(error: unknown): unknown {
    const { code, status, signal } = error as { code?: unknown; status?: unknown; signal?: unknown };
    if (code === "ENOENT") {
        return new CliError("buf was not found on the PATH. `proto sync` runs `buf generate` to produce the types; install buf (https://buf.build/docs/installation).", {
            cause: error,
        });
    }
    if (typeof status === "number") {
        return new CliError(`buf generate failed with exit code ${status}; see its output above.`, { cause: error });
    }
    if (typeof signal === "string") {
        return new CliError(`buf generate was terminated by ${signal}.`, { cause: error });
    }
    return error;
}

/**
 * Full sync: fetch descriptors, write .binpb, run buf generate.
 */
async function executeFullSync(url: string, out: string, timeoutMs: number, template?: string): Promise<void> {
    // Checked before connecting: a typo in the path would otherwise be found only after the
    // descriptors were fetched, as the opaque failure of `buf generate`.
    if (template && !isExistingFile(template)) {
        throw new CliError(`--template "${template}" is not an existing file.`);
    }

    console.log(`Connecting to ${url}...`);

    // Step 1: Fetch FileDescriptorSet as binary
    const binpb = await fetchFileDescriptorSetBinary(url, { timeoutMs }).catch((error: unknown) => {
        throw describeReflectionFailure(url, error);
    });
    console.log(`Fetched ${binpb.byteLength} bytes of descriptors`);

    // Step 2: Write to temporary file
    const tmpDir = mkdtempSync(join(tmpdir(), "connectum-proto-sync-"));
    const binpbPath = join(tmpDir, "descriptors.binpb");

    // The write is inside the try on purpose: when it fails (disk full, permissions) the
    // directory just created must still be removed by the finally below.
    try {
        writeFileSync(binpbPath, binpb);

        // Step 3: Run buf generate (execFileSync prevents command injection)
        const args = ["generate", binpbPath, "--output", out];
        if (template) {
            args.push("--template", template);
        }

        console.log(`Running: buf ${args.join(" ")}`);
        try {
            execFileSync("buf", args, { stdio: "inherit" });
        } catch (error) {
            throw describeBufFailure(error);
        }

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
        throw new CliError(`--timeout must be a positive integer number of milliseconds (at most ${MAX_REFLECTION_TIMEOUT_MS}), got "${raw}".`);
    }
    return Number(raw);
}

/** Flags of `connectum proto sync`; also the list unknown flags are checked against. */
const protoSyncArgs = {
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
} as const;

/**
 * citty command definition for `connectum proto sync`.
 */
export const protoSyncCommand = defineCommand({
    meta: {
        name: "sync",
        description: "Sync proto types from a running Connectum server via gRPC Reflection",
    },
    args: protoSyncArgs,
    async run({ args, rawArgs }) {
        await runReported(async () => {
            assertKnownFlags("connectum proto sync", args, rawArgs, protoSyncArgs);
            await executeProtoSync({
                from: args.from,
                out: args.out,
                template: args.template,
                dryRun: args["dry-run"],
                timeoutMs: parseTimeoutOption(args.timeout),
            });
        });
    },
});
