/**
 * Generate `buf.yaml` from the module set.
 *
 * Composes the module list (the project's `proto`, plus the auth option proto from
 * `node_modules` when auth is enabled) and the lint `except` list. Event-handler
 * services and the auth/events option protos intentionally violate STANDARD lint
 * (SERVICE_SUFFIX / RPC_*), so the relevant excepts are added to keep `buf lint` green.
 *
 * @module scaffold/bufConfig
 */

import { AUTH_BUF_MODULE } from "./authFragment.ts";
import type { ScaffoldConfig } from "./types.ts";

export function generateBufYaml(config: ScaffoldConfig): string {
    const modules = ["  - path: proto"];
    if (config.modules.auth) {
        modules.push(`  - path: ${AUTH_BUF_MODULE}`);
    }

    const excepts = new Set<string>();
    if (config.modules.events) {
        excepts.add("SERVICE_SUFFIX");
    }
    if (config.modules.events || config.modules.auth) {
        excepts.add("RPC_REQUEST_STANDARD_NAME");
        excepts.add("RPC_RESPONSE_STANDARD_NAME");
        excepts.add("RPC_REQUEST_RESPONSE_UNIQUE");
    }
    const exceptBlock = excepts.size > 0 ? `\n  except:\n${[...excepts].map((e) => `    - ${e}`).join("\n")}` : "";

    return `version: v2
modules:
${modules.join("\n")}
lint:
  use:
    - STANDARD${exceptBlock}
breaking:
  use:
    - FILE
`;
}
