/**
 * Fitness check of the fetched base project, run before it is transformed.
 *
 * The transform rewrites the base's `package.json`, and the generated server, entry and
 * end-to-end test import through the base's `#gen/*` and `#*` aliases, build against its
 * `tsconfig.json`, and register / call the sample `GreeterService`. A base that lacks one
 * of these (another `--ref`, a damaged download) would otherwise fail in the middle of the
 * transform with a raw runtime error, or worse, scaffold a project that cannot type-check.
 * Every defect is collected so the user fixes the base once, not once per run.
 *
 * @module scaffold/baseCheck
 */

import { GREETER_PROTO_PATH } from "./authFragment.ts";

/** What the sample needs from the base (only relevant without `--no-sample`). */
const GREETER_SERVICE_PATH = "src/services/greeterService.ts";

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Defects of the `package.json` text. */
function checkManifest(raw: string | undefined): string[] {
    if (raw === undefined) {
        return ["package.json is missing"];
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(raw);
    } catch (err) {
        return [`package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`];
    }
    if (!isPlainObject(parsed)) {
        return ["package.json must contain a JSON object"];
    }

    const defects: string[] = [];
    for (const section of ["dependencies", "devDependencies"] as const) {
        if (parsed[section] !== undefined && !isPlainObject(parsed[section])) {
            defects.push(`package.json "${section}" must be an object`);
        }
    }
    const imports = parsed.imports;
    if (!isPlainObject(imports)) {
        defects.push('package.json has no "imports" aliases "#gen/*" and "#*", which the generated code imports through');
    } else {
        for (const alias of ["#gen/*", "#*"]) {
            if (!(alias in imports)) {
                defects.push(`package.json "imports" has no "${alias}" alias, which the generated code imports through`);
            }
        }
    }
    return defects;
}

/** Defects of the sample Greeter proto text. */
function checkGreeterProto(proto: string): string[] {
    const defects: string[] = [];
    if (!/\bservice\s+GreeterService\b/.test(proto)) {
        defects.push(`${GREETER_PROTO_PATH} declares no \`service GreeterService\`, which the generated server registers`);
    }
    for (const rpc of ["SayHello", "SayGoodbye"]) {
        if (!new RegExp(`\\brpc\\s+${rpc}\\b`).test(proto)) {
            defects.push(`${GREETER_PROTO_PATH} declares no \`rpc ${rpc}\`, which the generated end-to-end test calls`);
        }
    }
    return defects;
}

/**
 * Every reason the fetched base cannot be turned into a working project, in a fixed order;
 * empty when it is fit.
 *
 * @param files - the fetched base (relative path -> content)
 * @param options - `sample`: whether the sample Greeter service is wanted (its files are
 *   then required from the base)
 */
export function findBaseDefects(files: ReadonlyMap<string, string>, options: { sample: boolean }): string[] {
    if (files.size === 0) {
        return ["the base contains no files"];
    }
    const defects = checkManifest(files.get("package.json"));
    if (!files.has("tsconfig.json")) {
        defects.push("tsconfig.json is missing (the generated `typecheck` script runs `tsc`)");
    }
    if (options.sample) {
        const proto = files.get(GREETER_PROTO_PATH);
        if (proto === undefined) {
            defects.push(`${GREETER_PROTO_PATH} is missing`);
        } else {
            defects.push(...checkGreeterProto(proto));
        }
        if (!files.has(GREETER_SERVICE_PATH)) {
            defects.push(`${GREETER_SERVICE_PATH} is missing`);
        }
    }
    return defects;
}

/**
 * Throw one error listing every defect of the fetched base.
 *
 * @param ref - the git ref the base was fetched from, named in the message
 * @throws Error when the base is not fit
 */
export function assertFitBase(files: ReadonlyMap<string, string>, options: { sample: boolean }, ref?: string): void {
    const defects = findBaseDefects(files, options);
    if (defects.length === 0) {
        return;
    }
    const origin = ref === undefined ? "the base project" : `the base project fetched from "${ref}"`;
    throw new Error(`connectum init: ${origin} cannot be used:\n  - ${defects.join("\n  - ")}`);
}
