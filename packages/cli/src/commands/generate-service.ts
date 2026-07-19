/**
 * `connectum generate service <name>` — scaffold a service with empty handlers.
 *
 * This module wires the command into the CLI (OpenSpec change cli-scaffolding,
 * task 0.1). The generation behaviour — rpc/event handler skeletons (D-6),
 * proto scaffolding (D-10) and the printed registration edit (D-11) — lands in
 * Phase 3; until then the command is registered but intentionally not
 * functional. The behaviour flags (`--with-events`, `--strict-empty`) are added
 * in Phase 3, when they are actually consumed.
 *
 * @module commands/generate-service
 */

import { defineCommand } from "citty";

/**
 * Options for the `generate service` pipeline (grows as Phase 3 lands).
 */
export interface GenerateServiceOptions {
    /** Service name. */
    name: string;
}

/**
 * Execute the `generate service` pipeline.
 *
 * Phase 0 delivers the command seam only. Fails loudly rather than pretending to
 * succeed.
 *
 * @param options - Generate-service configuration
 */
export async function executeGenerateService(options: GenerateServiceOptions): Promise<void> {
    throw new Error(`connectum generate service: not yet functional — implemented in OpenSpec change cli-scaffolding, Phase 3. Requested service: ${options.name}`);
}

/**
 * citty command definition for `connectum generate service`.
 */
export const generateServiceCommand = defineCommand({
    meta: {
        name: "service",
        description: "Scaffold a service with empty rpc/event handlers (work in progress)",
    },
    args: {
        name: {
            type: "positional",
            description: "Service name",
            required: true,
        },
    },
    async run({ args }) {
        await executeGenerateService({ name: args.name });
    },
});
