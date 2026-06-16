// Gate checks 1+2 — publish-boundary oracle over the installed (packed) build.
// Mechanical, no hand-written references:
//  (1) enumerate every `exports` subpath from each INSTALLED @connectum/* package.json
//      and resolve each to a real file (broken export map => publish bug)
//  (2) build a TS Program that namespace-imports every subpath with skipLibCheck:false
//      under the realistic consumer tsconfig (DOM/fetch lib via target esnext)
//      => any module-resolution or .d.ts error surfaces as a diagnostic
//  + enumerate exports of every subpath via the type checker (value vs type),
//      so nothing is silently skipped — written to gen-cov/report.json for the
//      downstream completeness + runtime-import checks.
// Output: gen-cov/report.json + console summary. Exit 1 on any failure.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const ROOT = resolve(".");
const NM = join(ROOT, "node_modules", "@connectum");

// --- discover installed @connectum packages + their declared export subpaths ---
const pkgs = readdirSync(NM).filter((d) => existsSync(join(NM, d, "package.json")));
const specs = []; // { spec, pkg, subpath, declared, target, resolved }
const exportMapFindings = [];
for (const pkg of pkgs.sort()) {
    const pjPath = join(NM, pkg, "package.json");
    const pj = JSON.parse(readFileSync(pjPath, "utf8"));
    const exp = pj.exports;
    if (!exp || typeof exp !== "object") {
        exportMapFindings.push(`@connectum/${pkg}: NO exports map (exports=${JSON.stringify(exp)})`);
        continue;
    }
    for (const key of Object.keys(exp)) {
        if (key === "./package.json") continue;
        const spec = key === "." ? `@connectum/${pkg}` : `@connectum/${pkg}/${key.slice(2)}`;
        // resolve the import/types/default target for existence check
        const cond = exp[key];
        const candidates = [];
        const collect = (v) => {
            if (typeof v === "string") candidates.push(v);
            else if (v && typeof v === "object") for (const k of Object.keys(v)) collect(v[k]);
        };
        collect(cond);
        let allResolve = true;
        const missing = [];
        for (const rel of candidates) {
            const abs = join(NM, pkg, rel);
            if (!existsSync(abs)) {
                allResolve = false;
                missing.push(rel);
            }
        }
        if (!allResolve) exportMapFindings.push(`${spec}: export target(s) missing on disk: ${missing.join(", ")}`);
        specs.push({ spec, pkg, subpath: key, candidates, resolved: allResolve });
    }
}

// --- build synthetic entry that namespace-imports every subpath ---
const lines = [];
specs.forEach((s, i) => {
    lines.push(`import * as s${i} from ${JSON.stringify(s.spec)};`);
});
specs.forEach((_, i) => {
    lines.push(`export { s${i} };`);
});
mkdirSync(join(ROOT, "gen-cov"), { recursive: true });
const entryPath = join(ROOT, "gen-cov", "__all.ts");
writeFileSync(entryPath, `${lines.join("\n")}\n`);

// --- TS program with the consumer tsconfig, skipLibCheck:false, verbatim off (probe file) ---
const tsconfig = ts.readConfigFile(join(ROOT, "tsconfig.json"), ts.sys.readFile).config;
const parsed = ts.parseJsonConfigFileContent(tsconfig, ts.sys, ROOT);
const options = {
    ...parsed.options,
    skipLibCheck: false,
    verbatimModuleSyntax: false,
    noEmit: true,
    noUnusedLocals: false,
};
const program = ts.createProgram([entryPath], options);
const checker = program.getTypeChecker();
const sf = program.getSourceFile(entryPath);

// diagnostics scoped to our probe + global/options + lib graph
const diags = [...program.getSyntacticDiagnostics(sf), ...program.getSemanticDiagnostics(sf), ...program.getGlobalDiagnostics(), ...program.getOptionsDiagnostics()];
// also collect declaration-file diagnostics in any installed @connectum package
// (covers both pkg.pr.new and file:-tarball installs — both land under @connectum)
const connectumDtsDiags = program.getSemanticDiagnostics().filter((d) => (d.file?.fileName ?? "").includes("@connectum"));

const fmtDiag = (d) => {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n");
    if (d.file && d.start != null) {
        const { line, character } = d.file.getLineAndCharacterOfPosition(d.start);
        return `${d.file.fileName}:${line + 1}:${character + 1} TS${d.code}: ${msg}`;
    }
    return `TS${d.code}: ${msg}`;
};

// --- enumerate exports of every subpath via checker ---
const exportReport = {};
const importDecls = sf.statements.filter(ts.isImportDeclaration);
specs.forEach((s, i) => {
    const decl = importDecls[i];
    const modSym = checker.getSymbolAtLocation(decl.moduleSpecifier);
    if (!modSym) {
        exportReport[s.spec] = { resolved: false, error: "module symbol not found (unresolved)" };
        return;
    }
    const exports = checker.getExportsOfModule(modSym);
    const values = [],
        types = [];
    for (const ex of exports) {
        let sym = ex;
        if (sym.flags & ts.SymbolFlags.Alias) {
            try {
                sym = checker.getAliasedSymbol(ex);
            } catch {}
        }
        const f = sym.flags;
        const isValue = !!(f & ts.SymbolFlags.Value);
        const isType = !!(f & (ts.SymbolFlags.Type | ts.SymbolFlags.Interface | ts.SymbolFlags.TypeAlias | ts.SymbolFlags.TypeParameter | ts.SymbolFlags.EnumMember));
        if (isValue) values.push(ex.getName());
        else if (isType) types.push(ex.getName());
        else values.push(ex.getName()); // namespaces etc.
    }
    exportReport[s.spec] = { resolved: true, valueCount: values.length, typeCount: types.length, values: values.sort(), types: types.sort() };
});

const allDiags = [...diags, ...connectumDtsDiags];
const uniq = [...new Map(allDiags.map((d) => [fmtDiag(d), d])).values()];
const errs = uniq.filter((d) => d.category === ts.DiagnosticCategory.Error);

const report = {
    target: process.env.GATE_TARGET ?? "(unspecified)",
    packages: pkgs.length,
    subpaths: specs.length,
    exportMapFindings,
    unresolvedSubpaths: specs.filter((s) => !s.resolved).map((s) => s.spec),
    tsErrorCount: errs.length,
    tsErrors: errs.map(fmtDiag),
    exports: exportReport,
};
writeFileSync(join(ROOT, "gen-cov", "report.json"), JSON.stringify(report, null, 2));

console.log(`packages=${report.packages} subpaths=${report.subpaths}`);
console.log(`export-map findings: ${exportMapFindings.length}`);
for (const f of exportMapFindings) console.log(`  EXPORTMAP ${f}`);
console.log(`unresolved subpaths: ${report.unresolvedSubpaths.length}`);
for (const s of report.unresolvedSubpaths) console.log(`  UNRESOLVED ${s}`);
console.log(`TS errors: ${errs.length}`);
for (const e of errs.slice(0, 60)) console.log(`  TSERR ${fmtDiag(e)}`);
let totV = 0,
    totT = 0;
for (const k of Object.keys(exportReport)) {
    totV += exportReport[k].valueCount || 0;
    totT += exportReport[k].typeCount || 0;
}
console.log(`total value exports enumerated=${totV}, type exports enumerated=${totT}`);
process.exit(errs.length || exportMapFindings.length || report.unresolvedSubpaths.length ? 1 : 0);
