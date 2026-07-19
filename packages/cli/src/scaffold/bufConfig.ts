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

/**
 * Generate `buf.gen.yaml`. protoc-gen-es always; the catalog plugin
 * (`protoc-gen-connectum-catalog`, `strategy: all`) is added when `catalog` is enabled
 * so `serviceCatalog` / typed `ctx.call` are generated into a single `catalog.gen.ts`.
 */
export function generateBufGenYaml(config: ScaffoldConfig): string {
    const catalogPlugin = config.modules.catalog
        ? `
  - local: protoc-gen-connectum-catalog
    strategy: all
    out: gen
    opt:
      - target=ts
      - import_extension=.ts`
        : "";
    return `version: v2
clean: true
inputs:
  - directory: proto
plugins:
  - local: protoc-gen-es
    out: gen
    opt:
      - target=ts
      - import_extension=.ts${catalogPlugin}
`;
}
