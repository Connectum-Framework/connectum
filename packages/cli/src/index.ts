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

import { readFileSync } from "node:fs";
import { defineCommand, runMain } from "citty";
import { protoSyncCommand } from "./commands/proto-sync.ts";

// Read the version from package.json so `connectum --version` always reports the
// real published release instead of a hand-maintained (and drift-prone) string.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const main = defineCommand({
    meta: {
        name: "connectum",
        version,
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
