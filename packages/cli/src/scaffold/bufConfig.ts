/**
 * Generate `buf.yaml` and `buf.gen.yaml` from the module set.
 *
 * `buf.yaml` composes the module list (the project's `proto`, plus the auth option proto
 * from `node_modules` when auth is enabled) and the lint `except` list. Event-handler
 * services and the auth/events option protos intentionally violate STANDARD lint
 * (SERVICE_SUFFIX / RPC_*), so the relevant excepts are added to keep `buf lint` green.
 *
 * `buf.gen.yaml` makes the generated code import Connectum's own option descriptors
 * from `@connectum/auth` / `@connectum/events` instead of generating local copies.
 *
 * @module scaffold/bufConfig
 */

import { posix } from "node:path";
import { AUTH_BUF_MODULE } from "./authFragment.ts";
import { EVENTS_OPTIONS_PROTO_PATH } from "./eventsFragment.ts";
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

/** A Connectum option proto whose generated descriptors a project imports from a package. */
export interface OptionProtoImport {
    /** Proto directory the option proto lives in, as `import` statements name it. */
    readonly protoDir: string;
    /** npm package that exports the generated module (`<pkg>/gen/<protoDir>options_pb.js`). */
    readonly pkg: string;
}

/**
 * The option protos the enabled modules bring in, each mapped to the package that
 * exports its generated descriptors. Both packages export the subpath since 1.3.0,
 * which is why versionFloors.ts raises the `@connectum/*` slice for these packages.
 */
export function optionProtoImports(config: ScaffoldConfig): OptionProtoImport[] {
    const imports: OptionProtoImport[] = [];
    if (config.modules.auth) {
        imports.push({ protoDir: "connectum/auth/v1/", pkg: "@connectum/auth" });
    }
    if (config.modules.events) {
        imports.push({ protoDir: "connectum/events/v1/", pkg: "@connectum/events" });
    }
    return imports;
}

/**
 * Generate `buf.gen.yaml`. protoc-gen-es always, with erasable enums; the catalog plugin
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

    // Connectum option protos (auth, events) are compiled but never generated here: the
    // generated code imports their descriptors from the package that ships them, so the
    // project and the package share one descriptor instead of each holding a copy.
    // Two pieces do that, and both are needed:
    // - `map_imports` (protoc-gen-es >= 2.15.0, covered by the floor in versionFloors.ts)
    //   rewrites an import of `connectum/<p>/v1/...` to `@connectum/<p>/gen/...`. It only
    //   rewrites import paths; on its own the option proto would still be generated.
    // - A single input, `directory: proto`, stops that. It makes the auth option module
    //   (the second buf module under node_modules) an import-only dependency, and
    //   `exclude_paths` does the same for the vendored events option proto, which must
    //   stay inside `proto/` because the project's protos import it.
    // The single input matters: one input per module would run each plugin once per
    // input, and the services-less auth module would clobber catalog.gen.ts.
    //
    // Without auth or events there is nothing to import, and `inputs` is left out so buf
    // uses the whole local workspace declared by buf.yaml — exactly as before.
    const optionImports = optionProtoImports(config);
    const excludedDir = posix.dirname(EVENTS_OPTIONS_PROTO_PATH);
    const inputs =
        optionImports.length === 0
            ? ""
            : `inputs:
  - directory: proto${config.modules.events ? `\n    exclude_paths:\n      - ${excludedDir}` : ""}
`;
    const mapImports = optionImports.map(({ protoDir, pkg }) => `\n      - map_imports=${protoDir}:${pkg}/gen`).join("");

    // `erasable_syntax=true` makes protoc-gen-es emit each Protobuf enum as an `as const`
    // object plus a same-named type instead of a TypeScript `enum`. The scaffolded project
    // runs `node src/index.ts` with native type stripping and type-checks with
    // `erasableSyntaxOnly`; both reject `enum`, so without it the first enum a user adds
    // breaks `start` and `typecheck`. The output needs the protobuf-es floor from
    // versionFloors.ts. The catalog plugin must NOT get this option or `map_imports`: it
    // rejects every option it does not know.
    return `version: v2
clean: true
${inputs}plugins:
  - local: protoc-gen-es
    out: gen
    opt:
      - target=ts
      - import_extension=.ts
      - erasable_syntax=true${mapImports}${catalogPlugin}
`;
}
