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

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { defineCommand } from "citty";
import { buildServiceFiles, packageName, pascalCase, registrationMessage, serviceModulePath } from "../scaffold/generateService.ts";
import { serviceNameProblems } from "../scaffold/serviceName.ts";
import { CliError, runReported } from "../utils/cliError.ts";
import { emitFiles } from "../utils/emit.ts";
import { assertKnownFlags } from "../utils/flags.ts";

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
 * Refuse a name whose proto file already exists but belongs to another service.
 *
 * Two names can map onto one proto path (`ab` and `a-b` both give `proto/ab/v1/ab.proto`) while
 * their services are named differently (`AbService`, `ABService`). The emission skips an existing
 * file, so the second name would get a new module importing a service that the kept proto does
 * not declare: a project that no longer compiles. The check applies only when the service module
 * is about to be written; a repeated run of the same name (module already there) stays a no-op.
 */
function assertProtoBelongsToName(options: { targetDir: string; name: string; withEvents: boolean }): void {
    const { targetDir, name, withEvents } = options;
    const protoPath = `proto/${packageName(name)}/v1/${packageName(name)}.proto`;
    if (existsSync(join(targetDir, serviceModulePath(name)))) {
        return;
    }
    let proto: string;
    try {
        proto = readFileSync(join(targetDir, protoPath), "utf8");
    } catch {
        // No readable proto: either nothing to collide with, or the emission layer reports the conflict.
        return;
    }
    const expected = [`${pascalCase(name)}Service`, ...(withEvents ? [`${pascalCase(name)}EventHandlers`] : [])];
    const missing = expected.filter((service) => !new RegExp(`^\\s*service\\s+${service}\\s*\\{`, "m").test(proto));
    if (missing.length > 0) {
        throw new Error(
            `connectum generate service: "${name}" maps to ${protoPath}, which already exists and does not declare ${missing.join(", ")} — it belongs to another service name that gives the same package. Nothing was written. Choose a different name, or pass --force to overwrite the proto.`,
        );
    }
}

/** Dependency sections of `package.json` in which a package counts as part of the project. */
const DEPENDENCY_SECTIONS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;

/**
 * Refuse a target directory that is not a project the generated files can work in.
 *
 * The generated module imports `@connectum/core`, and with `--with-events` its event route comes
 * from `@connectum/events`; in a directory without a `package.json`, or in a project without the
 * events module, the files are written and then fail to compile (`TS2307`, `TS7006`). The check
 * runs before the first file is written, so a refusal leaves the directory as it was.
 */
function assertProjectFits(options: { targetDir: string; withEvents: boolean }): void {
    const { targetDir, withEvents } = options;
    const manifestPath = join(targetDir, "package.json");
    let text: string;
    try {
        text = readFileSync(manifestPath, "utf8");
    } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") {
            // A directory called package.json, or a file the process may not read: not "missing".
            throw new CliError(`connectum generate service: cannot read ${manifestPath} (${cause instanceof Error ? cause.message : String(cause)}). Nothing was written.`, {
                cause,
            });
        }
        throw new CliError(
            `connectum generate service: no package.json in "${targetDir}". Run the command in the root of a Connectum project (\`connectum init\` creates one). Nothing was written.`,
            { cause },
        );
    }
    let manifest: unknown;
    try {
        manifest = JSON.parse(text);
    } catch (cause) {
        throw new CliError(`connectum generate service: ${manifestPath} is not valid JSON (${cause instanceof Error ? cause.message : String(cause)}). Nothing was written.`, {
            cause,
        });
    }
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
        throw new CliError(`connectum generate service: ${manifestPath} does not hold a JSON object. Nothing was written.`);
    }
    if (!withEvents) {
        return;
    }
    const declared = DEPENDENCY_SECTIONS.some((section) => {
        const dependencies = (manifest as Record<string, unknown>)[section];
        return typeof dependencies === "object" && dependencies !== null && "@connectum/events" in dependencies;
    });
    if (!declared) {
        throw new CliError(
            "connectum generate service: --with-events needs @connectum/events in the dependencies of package.json, and this project does not have it. Add it with an adapter (for example @connectum/events-nats), or scaffold the project with `connectum init --events <adapter>`. Nothing was written.",
        );
    }
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
    // The name feeds the proto package (`<pkg>.v1`), the proto service identifier
    // (`<Pascal>Service`), a TypeScript binding (`<camel>Service`) and two file paths, all
    // built by keeping only ASCII letters and digits. A name with anything else would be
    // changed without notice, and one that does not start with a letter yields an identifier
    // that neither proto nor TypeScript accepts, so both are refused before anything is emitted.
    const problems = serviceNameProblems(name);
    if (problems.length > 0) {
        throw new Error(`connectum generate service: invalid service name "${name}": ${problems.join("; ")}. Use a name like "billing" or "billing-v2".`);
    }
    const withEvents = options.withEvents ?? false;
    const force = options.force ?? false;
    const targetDir = resolve(options.cwd ?? process.cwd());

    assertProjectFits({ targetDir, withEvents });
    const files = buildServiceFiles(name, withEvents);
    if (!force) {
        assertProtoBelongsToName({ targetDir, name, withEvents });
    }
    const result = emitFiles(targetDir, files, { force });

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

/** Flags and the positional name of `connectum generate service`; also the list unknown flags are checked against. */
const generateServiceArgs = {
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
} as const;

/**
 * citty command definition for `connectum generate service`.
 */
export const generateServiceCommand = defineCommand({
    meta: {
        name: "service",
        description: "Scaffold a service with empty rpc/event handlers",
    },
    args: generateServiceArgs,
    async run({ args, rawArgs }) {
        await runReported(async () => {
            assertKnownFlags("connectum generate service", args, rawArgs, generateServiceArgs);
            await executeGenerateService({
                name: args.name,
                withEvents: args["with-events"],
                force: args.force,
            });
        });
    },
});
