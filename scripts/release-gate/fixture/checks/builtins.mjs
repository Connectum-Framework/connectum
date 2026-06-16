// Gate check 5 — node: protocol on prefix-only builtins.
//
// tsup's `removeNodeProtocol: true` default strips the `node:` prefix from
// builtin imports. For most builtins (fs, crypto, os, http2, assert, …) the
// bare form is a valid Node alias, so stripping is only a style issue. But a
// handful of builtins are exposed ONLY under the `node:` prefix and have NO bare
// alias — `node:test`, `node:test/reporters`, `node:sqlite`, `node:sea`. If the
// build strips the prefix from one of these, the published artifact ships an
// unresolvable bare specifier (`import { test } from "test"` → Cannot find
// package 'test') for every consumer. This is the @connectum/testing/parity bug
// class; this static scan guards every package's shipped .js against it.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const NM = resolve("node_modules", "@connectum");
// Builtins with NO bare alias — they MUST keep the node: prefix.
const PREFIX_ONLY = ["test", "test/reporters", "sqlite", "sea"];
const bareRe = new RegExp(`(?:from\\s*|import\\s*\\(\\s*|require\\s*\\(\\s*)["'](${PREFIX_ONLY.map((b) => b.replace("/", "\\/")).join("|")})["']`, "g");

function jsFiles(dir, acc) {
    for (const e of readdirSync(dir)) {
        const p = join(dir, e);
        const st = statSync(p);
        if (st.isDirectory()) {
            if (e !== "node_modules") jsFiles(p, acc);
        } else if (e.endsWith(".js") || e.endsWith(".mjs") || e.endsWith(".cjs")) acc.push(p);
    }
    return acc;
}

const hits = [];
for (const pkg of readdirSync(NM).sort()) {
    const dist = join(NM, pkg, "dist");
    if (!existsSync(dist)) continue;
    for (const file of jsFiles(dist, [])) {
        const src = readFileSync(file, "utf8");
        for (const m of src.matchAll(bareRe)) {
            hits.push({ pkg: `@connectum/${pkg}`, file: file.slice(NM.length + 1), bare: m[1] });
        }
    }
}

if (hits.length === 0) {
    console.log(`builtins: OK — no prefix-only Node builtin (${PREFIX_ONLY.join(", ")}) shipped without its node: prefix`);
    process.exit(0);
}
console.log(`builtins: FAIL — ${hits.length} stripped node: prefix on a prefix-only builtin:`);
for (const h of hits) console.log(`  ${h.pkg} ${h.file}: bare "${h.bare}" (must be "node:${h.bare}")`);
process.exit(1);
