#!/usr/bin/env node
/**
 * Build the image with the external gRPC clients used by the interop suites
 * (`docker/interop-tools/Dockerfile`) under the tag the suites run.
 *
 *     node scripts/interop-tools.mjs
 *
 * Safe to repeat: Docker reuses the cached layers when the Dockerfile has not
 * changed. CI runs the same command before `test:interop`.
 */

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { INTEROP_TOOLS_IMAGE } from "../tests/interop/tools.ts";

const context = fileURLToPath(new URL("../docker/interop-tools", import.meta.url));
const result = spawnSync("docker", ["build", "--tag", INTEROP_TOOLS_IMAGE, context], { stdio: "inherit" });
if (result.error) {
    console.error(`interop-tools: cannot run docker: ${result.error.message}`);
    process.exit(1);
}
process.exit(result.status ?? 1);
