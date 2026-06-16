// Gate check 3 — build-drop detection. The .d.ts (checked by tsc) and the .js
// (run at runtime) are validated separately; nothing else asserts they AGREE. A
// value symbol present in the published .d.ts but dropped from the .js is the
// canonical tsup publish-boundary bug and passes the other checks silently. For
// each subpath, diff enumerated .d.ts value-exports vs runtime Object.keys.
// Any delta fails the gate. Reads gen-cov/report.json produced by oracle.mjs.
import { readFileSync } from "node:fs";
import { importExceptionReason } from "./allowlist.mjs";

const report = JSON.parse(readFileSync("./gen-cov/report.json", "utf8"));

const deltas = [];
for (const [spec, info] of Object.entries(report.exports)) {
    if (importExceptionReason(spec) || !info.resolved) continue;
    const declaredValues = info.values || [];
    if (declaredValues.length === 0) continue;
    let mod;
    try {
        mod = await import(spec);
    } catch (e) {
        deltas.push({ spec, kind: "IMPORT-THREW", detail: e?.message ?? String(e) });
        continue;
    }
    const runtimeKeys = new Set(Object.keys(mod));
    const missing = declaredValues.filter((n) => !runtimeKeys.has(n));
    if (missing.length) deltas.push({ spec, kind: "DECLARED-NOT-IN-RUNTIME", missing });
}

if (deltas.length === 0) {
    console.log("completeness: OK — every .d.ts value export present in runtime Object.keys");
    process.exit(0);
}
console.log(`completeness: FAIL — ${deltas.length} build-drop delta(s):`);
for (const d of deltas) console.log(`  ${JSON.stringify(d)}`);
process.exit(1);
