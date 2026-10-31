/**
 * The `package.json` a Connectum project has, for tests that run `generate service` in a
 * directory: the command refuses a directory that is not a project, so the directory needs one.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** Dependencies of a project scaffolded with `connectum init --events nats`. */
export const EVENTS_PROJECT_DEPENDENCIES: Readonly<Record<string, string>> = {
    "@connectum/core": "^1.3.0",
    "@connectum/events": "^1.3.0",
    "@connectum/events-nats": "^1.3.0",
};

/** Writes `package.json` into `dir`; by default that of a project that has the events module. */
export function writeProjectManifest(dir: string, dependencies: Readonly<Record<string, string>> = EVENTS_PROJECT_DEPENDENCIES): void {
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "demo", type: "module", dependencies }, null, 2)}\n`);
}
