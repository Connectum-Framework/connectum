/**
 * `connectum generate service <name>` — scaffold a service with empty handlers.
 *
 * Scaffolds a starter proto + a `defineService` skeleton (rpc stubs throw
 * Unimplemented, D-6) and, with `--with-events`, an event-handler `EventRoute`.
 * Per D-11 the composition root (`src/server.ts`) is user-owned and NOT edited —
 * the command prints the exact registration edit instead. Refuse-to-clobber.
 *
 * @module commands/generate-service
 */

import { resolve } from "node:path";
import { defineCommand } from "citty";
import { buildServiceFiles, registrationMessage } from "../scaffold/generateService.ts";
import { emitFiles } from "../utils/emit.ts";

/**
 * Options for the `generate service` pipeline.
 */
export interface GenerateServiceOptions {
    /** Service name. */
    name: string;
    /** Also scaffold an event-handler service. */
    withEvents?: boolean | undefined;
    /** Overwrite existing files instead of skipping them. */
    force?: boolean | undefined;
    /** Target directory (defaults to cwd). */
    cwd?: string | undefined;
}

/**
 * Execute the `generate service` pipeline.
 *
 * @param options - Generate-service configuration
 */
export async function executeGenerateService(options: GenerateServiceOptions): Promise<void> {
    const name = options.name.trim();
    if (name === "") {
        throw new Error("connectum generate service: a service name is required (e.g. `connectum generate service billing`)");
    }
    const withEvents = options.withEvents ?? false;
    const targetDir = resolve(options.cwd ?? process.cwd());

    const files = buildServiceFiles(name, withEvents);
    const result = emitFiles(targetDir, files, { force: options.force ?? false });

    console.log(`Generated ${result.written.length} file(s) for service "${name}":`);
    for (const path of result.written) {
        console.log(`  + ${path}`);
    }
    if (result.skipped.length > 0) {
        console.log(`Skipped ${result.skipped.length} existing file(s): ${result.skipped.join(", ")}`);
    }
    console.log("");
    console.log(registrationMessage(name, withEvents));
}

/**
 * citty command definition for `connectum generate service`.
 */
export const generateServiceCommand = defineCommand({
    meta: {
        name: "service",
        description: "Scaffold a service with empty rpc/event handlers",
    },
    args: {
        name: {
            type: "positional",
            description: "Service name",
            required: true,
        },
        "with-events": {
            type: "boolean",
            description: "Also scaffold an event-handler service",
            default: false,
        },
        force: {
            type: "boolean",
            description: "Overwrite existing files",
            default: false,
        },
    },
    async run({ args }) {
        await executeGenerateService({
            name: args.name,
            withEvents: args["with-events"],
            force: args.force,
        });
    },
});
