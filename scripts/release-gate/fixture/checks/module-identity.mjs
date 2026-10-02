// Gate check — one module instance per package. Does a name exported by several
// subpaths of one package resolve to the same runtime value from each of them?
//
// A tsup build with several entries and `splitting: false` copies every module
// it imports into every entry file. The package then holds several instances of
// that module: a module-level singleton exists once per subpath (two
// OpenTelemetry providers fighting over the global registration), and a class
// exported by two subpaths is two classes (`instanceof` fails across them).
// Package tests import `src`, where Node loads each module once, so only the
// packed build shows it. This check imports every subpath of every packed
// package and compares, with ===, each name that two or more of them export.
// Executable entries are skipped with the reason recorded in allowlist.mjs.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { importExceptionReason } from "./allowlist.mjs";

const NM = resolve("node_modules", "@connectum");
const pkgs = readdirSync(NM).filter((d) => existsSync(join(NM, d, "package.json")));

let fail = 0;
let compared = 0;
for (const pkg of pkgs.sort()) {
    const pj = JSON.parse(readFileSync(join(NM, pkg, "package.json"), "utf8"));
    const specs = Object.keys(pj.exports || {})
        .filter((key) => key !== "./package.json")
        .map((key) => (key === "." ? `@connectum/${pkg}` : `@connectum/${pkg}/${key.slice(2)}`))
        .filter((spec) => importExceptionReason(spec) === null);
    if (specs.length < 2) continue;

    // name -> [{ spec, value }] across this package's subpaths
    const byName = new Map();
    for (const spec of specs) {
        const mod = await import(spec);
        for (const [name, value] of Object.entries(mod)) {
            if (name === "default") continue;
            if (!byName.has(name)) byName.set(name, []);
            byName.get(name).push({ spec, value });
        }
    }

    for (const [name, seen] of byName) {
        if (seen.length < 2) continue;
        compared++;
        const first = seen[0];
        const different = seen.filter((entry) => entry.value !== first.value);
        if (different.length > 0) {
            fail++;
            console.log(`XX @connectum/${pkg} export "${name}": ${first.spec} differs from ${different.map((entry) => entry.spec).join(", ")}`);
        }
    }
}

console.log(`module-identity: ${compared} names exported by two or more subpaths, failures=${fail}`);
process.exit(fail ? 1 : 0);
