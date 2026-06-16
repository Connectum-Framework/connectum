// Gate check 6 — consumer USAGE type-check. oracle.mjs proves the .d.ts graph is
// well-formed and resolves; it does NOT instantiate generics, call functions
// with typed arguments, or assign typed parameters. This check compiles a
// cast-free usage fixture (src/usage.ts) against the PACKED .d.ts under the
// realistic consumer tsconfig (verbatimModuleSyntax:true, strict) and fails on
// any diagnostic — catching signature regressions a consumer writing documented
// code would hit even when the declarations are well-formed.
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const ROOT = resolve(".");

const tsconfig = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile).config;
const parsed = ts.parseJsonConfigFileContent(tsconfig, ts.sys, ROOT);
// skipLibCheck:true — we want diagnostics on OUR usage site, not inside lib/.d.ts
// internals (those are covered by oracle.mjs with skipLibCheck:false).
const options = { ...parsed.options, skipLibCheck: true, noEmit: true };

const entry = join(ROOT, "src", "usage.ts");
const program = ts.createProgram([entry], options);

const fmt = (d) => {
    const m = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file && d.start != null) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
        return `${d.file.fileName}:${line + 1}:${character + 1} TS${d.code}: ${m}`;
    }
    return `TS${d.code}: ${m}`;
};

// Normalize separators — TS file names use `/`, but guard against `\` so the
// filter can't silently pass (hiding diagnostics) on Windows.
const diags = ts.getPreEmitDiagnostics(program).filter((d) => (d.file?.fileName ?? "").replace(/\\/g, "/").endsWith("/src/usage.ts"));
if (diags.length === 0) {
    console.log("usage-typecheck: OK — documented consumer signatures type-check against the packed .d.ts");
    process.exit(0);
}
console.log(`usage-typecheck: FAIL — ${diags.length} diagnostic(s) on consumer usage:`);
for (const d of diags) console.log(`  ${fmt(d)}`);
process.exit(1);
