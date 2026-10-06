/**
 * Package-name rules for `connectum init`.
 *
 * The scaffolded `package.json` carries the project name as its `name`, and the name is also
 * written into generated source. The rules are those npm applies to a NEW package (npm docs,
 * `name` field of package.json, and `validate-npm-package-name`, whose warnings are also
 * rejected here): a name npm would not publish is a name the project cannot keep.
 *
 * @module scaffold/projectName
 */

import { builtinModules } from "node:module";
import { basename, resolve } from "node:path";

/** npm's limit on the length of a package name. */
const MAX_NAME_LENGTH = 214;

/** Characters that `encodeURIComponent` leaves alone but npm rejects in a new package name. */
const NPM_REJECTED_PUNCTUATION = /[~'!()*]/;
/** The same set, global, for stripping them before the URL-safety check. */
const NPM_REJECTED_PUNCTUATION_EVERYWHERE = /[~'!()*]/g;

/** Names npm reserves outright. */
const RESERVED_NAMES: ReadonlySet<string> = new Set(["node_modules", "favicon.ico"]);

/** Node.js core module names (the `_`-prefixed internals are already refused by the first-character rule). */
const CORE_MODULES: ReadonlySet<string> = new Set(builtinModules.filter((m) => !m.startsWith("_") && !m.startsWith("node:")));

/**
 * Every rule `name` breaks as a new npm package name, in a fixed order; empty when it is valid.
 */
export function packageNameProblems(name: string): string[] {
    if (name === "") {
        return ["it is empty"];
    }
    const problems: string[] = [];
    if (name.length > MAX_NAME_LENGTH) {
        problems.push(`it is longer than ${MAX_NAME_LENGTH} characters`);
    }
    if (/^[._-]/.test(name)) {
        problems.push("it must not start with `.`, `_` or `-`");
    }
    if (name !== name.toLowerCase()) {
        problems.push("it must be lower-case");
    }
    if (/\s/.test(name)) {
        problems.push("it must not contain whitespace");
    }
    if (NPM_REJECTED_PUNCTUATION.test(name)) {
        problems.push("it must not contain one of `~ ' ! ( ) *`, which npm rejects for new packages");
    }
    const withoutPunctuation = name.replace(NPM_REJECTED_PUNCTUATION_EVERYWHERE, "");
    if (encodeURIComponent(withoutPunctuation) !== withoutPunctuation) {
        problems.push("it contains characters that are not URL-safe");
    }
    if (RESERVED_NAMES.has(name)) {
        problems.push(`\`${name}\` is a reserved name`);
    }
    if (CORE_MODULES.has(name)) {
        problems.push(`\`${name}\` is a Node.js core module name`);
    }
    return problems;
}

/**
 * Split the `init` argument into the destination as typed and the package name: the last
 * segment of the resolved path (so `.` takes the name of the current directory).
 *
 * @throws Error naming the name and every rule it breaks.
 */
export function resolveProjectTarget(input: string, cwd: string): { dir: string; name: string } {
    const name = basename(resolve(cwd, input));
    const problems = packageNameProblems(name);
    if (problems.length > 0) {
        const shown = input === name ? `"${name}"` : `"${name}" (the last segment of "${input}")`;
        throw new Error(`connectum init: invalid project name ${shown}: ${problems.join("; ")}. Choose a path whose last segment is a valid new npm package name.`);
    }
    return { dir: input, name };
}
