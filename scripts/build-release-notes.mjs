#!/usr/bin/env node
/**
 * build-release-notes.mjs — generate highlights-first, deduplicated release notes
 * for a given version from the per-package CHANGELOG.md files.
 *
 * Output structure (always, for both the GitHub Release and the Version Packages PR):
 *   ## Highlights        — curated, from .github/RELEASE_HIGHLIGHTS.md (maintainer-edited)
 *   ## Repo-wide changes — changeset entries that are identical across >= 2 packages,
 *                          printed once with an "Affects:" line (e.g. the Node.js floor)
 *   ## Package changes   — per package, only the entries unique to that package
 *
 * Usage: node scripts/build-release-notes.mjs <version> [--packages-dir <dir>] [--highlights <file>]
 *
 * Reads packages/<name>/CHANGELOG.md, extracts the `## <version>` section of each,
 * and writes the assembled Markdown to stdout. Designed to be safe in CI: if a
 * package has no entry for the version it is skipped; if no highlights file exists
 * the Highlights section is omitted.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const version = args.find((a) => !a.startsWith("--"));
if (!version) {
    console.error("usage: build-release-notes.mjs <version> [--packages-dir <dir>] [--highlights <file>]");
    process.exit(2);
}
const getOpt = (name, fallback) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const packagesDir = getOpt("--packages-dir", "packages");
const highlightsFile = getOpt("--highlights", ".github/RELEASE_HIGHLIGHTS.md");

const CATEGORIES = ["Major Changes", "Minor Changes", "Patch Changes"];

/** Extract the body of the `## <version>` section from a CHANGELOG. */
function extractVersionSection(changelog, ver) {
    const lines = changelog.split("\n");
    const start = lines.findIndex((l) => l.trim() === `## ${ver}`);
    if (start === -1) return null;
    const rest = lines.slice(start + 1);
    const endRel = rest.findIndex((l) => /^## \S/.test(l));
    return (endRel === -1 ? rest : rest.slice(0, endRel)).join("\n");
}

/**
 * Parse a version section into entries: { category, text }.
 * An entry starts at a top-level "- " bullet and runs until the next top-level
 * "- " bullet, the next "### " category heading, or the end of the section.
 * "Updated dependencies" bookkeeping bullets (changeset internal version churn)
 * are dropped — they are not user-facing release information.
 */
function parseEntries(section) {
    const lines = section.split("\n");
    const entries = [];
    let category = null;
    let buf = null;
    const flush = () => {
        if (buf) {
            const text = buf.join("\n").replace(/\s+$/, "");
            if (text.trim() && !/^- Updated dependencies\b/.test(text)) {
                entries.push({ category, text });
            }
            buf = null;
        }
    };
    for (const line of lines) {
        const cat = CATEGORIES.find((c) => line.trim() === `### ${c}`);
        if (cat) {
            flush();
            category = cat;
            continue;
        }
        if (/^- /.test(line)) {
            flush();
            buf = [line];
        } else if (buf) {
            buf.push(line);
        }
    }
    flush();
    return entries;
}

// Collect entries from every package.
const pkgNames = readdirSync(packagesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

const perPackage = new Map(); // pkgName -> entries[]
const groups = new Map(); // entry text -> { entry, pkgs:Set, order }
let order = 0;

for (const name of pkgNames) {
    const changelogPath = join(packagesDir, name, "CHANGELOG.md");
    const pkgJsonPath = join(packagesDir, name, "package.json");
    if (!existsSync(changelogPath) || !existsSync(pkgJsonPath)) continue;
    const pkgName = JSON.parse(readFileSync(pkgJsonPath, "utf8")).name;
    const section = extractVersionSection(readFileSync(changelogPath, "utf8"), version);
    if (section == null) continue;
    const entries = parseEntries(section);
    if (!entries.length) continue;
    perPackage.set(pkgName, entries);
    for (const e of entries) {
        const key = e.text.trim();
        if (!groups.has(key)) groups.set(key, { entry: e, pkgs: new Set(), order: order++ });
        groups.get(key).pkgs.add(pkgName);
    }
}

const sharedKeys = new Set([...groups.entries()].filter(([, g]) => g.pkgs.size >= 2).map(([k]) => k));

const out = [];

// 1. Highlights (curated).
if (existsSync(highlightsFile)) {
    const hl = readFileSync(highlightsFile, "utf8").trim();
    if (hl) {
        out.push("## Highlights", "", hl, "");
    }
}

// 2. Repo-wide changes — shared entries, once, in first-seen order, with affected packages.
const shared = [...groups.values()].filter((g) => g.pkgs.size >= 2).sort((a, b) => a.order - b.order);
if (shared.length) {
    out.push("## Repo-wide changes", "", "These changeset entries appear identically across multiple packages and are listed once.", "");
    for (const g of shared) {
        out.push(g.entry.text);
        const pkgs = [...g.pkgs].sort();
        out.push("", `  _Affects: ${pkgs.join(", ")} (${pkgs.length} packages)._`, "");
    }
}

// 3. Package changes — per package, entries unique to that package.
out.push("## Package changes", "");
for (const pkgName of [...perPackage.keys()].sort()) {
    out.push(`### ${pkgName}@${version}`, "");
    const unique = perPackage.get(pkgName).filter((e) => !sharedKeys.has(e.text.trim()));
    if (!unique.length) {
        out.push("No package-specific changes beyond the repo-wide items above.", "");
        continue;
    }
    for (const cat of CATEGORIES) {
        const inCat = unique.filter((e) => e.category === cat);
        if (!inCat.length) continue;
        out.push(`**${cat.replace(" Changes", "")}**`, "");
        for (const e of inCat) out.push(e.text, "");
    }
}

process.stdout.write(
    `${out
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd()}\n`,
);
