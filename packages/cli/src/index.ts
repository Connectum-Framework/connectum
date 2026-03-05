/**
 * @connectum/cli
 *
 * CLI tools for Connectum framework.
 *
 * Commands:
 * - connectum proto sync  -- Sync proto types from a running server via reflection
 *
 * @module @connectum/cli
 * @mergeModuleWith <project>
 */

import { defineCommand, runMain } from "citty";
import { protoSyncCommand } from "./commands/proto-sync.ts";

const main = defineCommand({
    meta: {
        name: "connectum",
        version: "0.2.0-alpha.2",
        description: "CLI tools for Connectum gRPC/ConnectRPC framework",
    },
    subCommands: {
        proto: defineCommand({
            meta: {
                name: "proto",
                description: "Proto management commands",
            },
            subCommands: {
                sync: protoSyncCommand,
            },
        }),
    },
});

runMain(main);
