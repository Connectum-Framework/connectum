// Gate check 4 — runtime importability. Does every published subpath actually
// import() under Node ESM? Catches .js that throws on load, ESM/CJS interop
// breaks, a stripped node: builtin, missing default. Each import is raced
// against a timeout so a hanging module can't wedge the run. A subpath with
// zero declared value-exports (type-only, e.g. ./types) is expected to yield an
// empty namespace — not a failure (cross-referenced via gen-cov/report.json).
// Import-exception entries (executable / plugin `.`) are skipped with a reason.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { importExceptionReason } from "./allowlist.mjs";

const report = JSON.parse(readFileSync("./gen-cov/report.json", "utf8"));
const NM = resolve("node_modules", "@connectum");
const pkgs = readdirSync(NM).filter((d) => existsSync(join(NM, d, "package.json")));
const specs = [];
for (const pkg of pkgs.sort()) {
    const pj = JSON.parse(readFileSync(join(NM, pkg, "package.json"), "utf8"));
    for (const key of Object.keys(pj.exports || {})) {
        if (key === "./package.json") continue;
        specs.push(key === "." ? `@connectum/${pkg}` : `@connectum/${pkg}/${key.slice(2)}`);
    }
}

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`TIMEOUT ${ms}ms`)), ms).unref())]);

let fail = 0;
const rows = [];
for (const spec of specs) {
    const reason = importExceptionReason(spec);
    if (reason) {
        rows.push(["  ", spec, `skip — ${reason}`]);
        continue;
    }
    const declaredValues = report.exports[spec]?.values?.length ?? null;
    try {
        const mod = await withTimeout(import(spec), 15000);
        const total = Object.keys(mod).length;
        // type-only subpath (0 declared value-exports) → empty namespace is expected
        if (total === 0 && declaredValues === 0) rows.push(["  ", spec, "ok (type-only: 0 runtime exports, expected)"]);
        else if (total === 0) {
            fail++;
            rows.push(["XX", spec, `EMPTY namespace but .d.ts declares ${declaredValues} value export(s)`]);
        } else rows.push(["  ", spec, `ok (${total} runtime exports)`]);
    } catch (e) {
        fail++;
        rows.push(["XX", spec, `IMPORT FAILED: ${e?.message ?? e}`]);
    }
}

for (const [mark, spec, status] of rows) console.log(`${mark} ${spec} :: ${status}`);
console.log(`runtime-import: ${rows.length} subpaths, failures=${fail}`);
process.exit(fail ? 1 : 0);
