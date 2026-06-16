// Gate check 3 — build-drop detection, both directions. The .d.ts (checked by
// tsc) and the .js (run at runtime) are validated separately; this asserts they
// AGREE on the value surface. Reads gen-cov/report.json produced by oracle.mjs.
//   forward: a value declared in the .d.ts but absent from the runtime
//            Object.keys = a value dropped by the build (the const-enum /
//            EffectiveTransport class of bug).
//   reverse: a name declared TYPE-ONLY in the .d.ts but present as a runtime
//            value = a value mislabeled type-only at the barrel (`export type
//            { X }` on a real value) → consumer `import { X }` + value use hits
//            TS2693. The exact inverse of the const-enum bug.
// Any delta fails the gate.
import { readFileSync } from "node:fs";
import { importExceptionReason } from "./allowlist.mjs";

const report = JSON.parse(readFileSync("./gen-cov/report.json", "utf8"));

const deltas = [];
for (const [spec, info] of Object.entries(report.exports)) {
    if (importExceptionReason(spec) || !info.resolved) continue;
    const declaredValues = info.values || [];
    const declaredTypes = info.types || [];
    let mod;
    try {
        mod = await import(spec);
    } catch (e) {
        deltas.push({ spec, kind: "IMPORT-THREW", detail: e?.message ?? String(e) });
        continue;
    }
    const runtimeKeys = new Set(Object.keys(mod));
    const droppedValues = declaredValues.filter((n) => !runtimeKeys.has(n));
    if (droppedValues.length) deltas.push({ spec, kind: "DECLARED-VALUE-NOT-IN-RUNTIME", names: droppedValues });
    const mislabeled = declaredTypes.filter((n) => runtimeKeys.has(n));
    if (mislabeled.length) deltas.push({ spec, kind: "RUNTIME-VALUE-DECLARED-TYPE-ONLY", names: mislabeled });
}

if (deltas.length === 0) {
    console.log("completeness: OK — .d.ts value exports ⇔ runtime Object.keys (both directions)");
    process.exit(0);
}
console.log(`completeness: FAIL — ${deltas.length} delta(s):`);
for (const d of deltas) console.log(`  ${JSON.stringify(d)}`);
process.exit(1);
