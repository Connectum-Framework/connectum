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
 * Usage: node scripts/build-release-notes.mjs <version> [--packages-dir <dir>] [--highlights <file>] [--max-bytes <N>]
 *
 * --max-bytes keeps the output within N UTF-8 bytes (a pull request body has a hard
 * size limit): whole sections are dropped from the end — Package changes first, then
 * Repo-wide changes — and each dropped section is replaced by one line saying why and
 * where the full text lives. Highlights is never dropped or cut; if it alone exceeds
 * N it is printed whole and the overrun is reported on stderr. Without the option the
 * output is the complete notes.
 *
 * Reads packages/<name>/CHANGELOG.md, extracts the `## <version>` section of each,
 * and writes the assembled Markdown to stdout. Designed to be safe in CI: if a
 * package has no entry for the version it is skipped; if no highlights file exists
 * the Highlights section is omitted.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const OPTS_WITH_VALUE = new Set(["--packages-dir", "--highlights", "--max-bytes"]);
const getOpt = (name, fallback) => {
    const i = args.indexOf(name);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
// Resolve the positional <version>, skipping option values so an invocation like
// `--packages-dir tmp 1.0.0` does not mistake the path "tmp" for the version.
const positionals = [];
for (let i = 0; i < args.length; i++) {
    if (OPTS_WITH_VALUE.has(args[i])) {
        i++; // skip the option's value
        continue;
    }
    if (!args[i].startsWith("--")) positionals.push(args[i]);
}
const version = positionals[0];
if (!version) {
    console.error("usage: build-release-notes.mjs <version> [--packages-dir <dir>] [--highlights <file>] [--max-bytes <N>]");
    process.exit(2);
}
const packagesDir = getOpt("--packages-dir", "packages");
const highlightsFile = getOpt("--highlights", ".github/RELEASE_HIGHLIGHTS.md");
const maxBytesRaw = getOpt("--max-bytes", null);
const maxBytes = maxBytesRaw === null ? null : Number(maxBytesRaw);
if (maxBytes !== null && !(Number.isInteger(maxBytes) && maxBytes > 0)) {
    console.error(`--max-bytes must be a positive integer, got "${maxBytesRaw}"`);
    process.exit(2);
}

const CATEGORIES = ["Major Changes", "Minor Changes", "Patch Changes"];

/**
 * Remove HTML comments (maintainer guidance in the highlights file) without a
 * regex, scanning for `<!--`/`-->` pairs. An unterminated `<!--` drops the
 * remainder so no dangling comment marker survives into the published notes.
 */
function stripHtmlComments(input) {
    let result = "";
    let i = 0;
    while (i < input.length) {
        const open = input.indexOf("<!--", i);
        if (open === -1) {
            result += input.slice(i);
            break;
        }
        result += input.slice(i, open);
        const close = input.indexOf("-->", open + 4);
        if (close === -1) break; // unterminated: drop the rest, leaving no `<!--`
        i = close + 3;
    }
    return result;
}

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
    if (section === null || section === undefined) continue;
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

const highlightsLines = [];
const sharedLines = [];
const packageLines = [];

// 1. Highlights (curated). HTML comments hold maintainer guidance that must not
// leak into the published notes, so they are stripped out.
if (existsSync(highlightsFile)) {
    const hl = stripHtmlComments(readFileSync(highlightsFile, "utf8"))
        .replace(/\n{3,}/g, "\n\n")
        .trim();
    if (hl) {
        highlightsLines.push("## Highlights", "", hl, "");
    }
}

// 2. Repo-wide changes — shared entries, once, in first-seen order, with affected packages.
const shared = [...groups.values()].filter((g) => g.pkgs.size >= 2).sort((a, b) => a.order - b.order);
if (shared.length) {
    sharedLines.push("## Repo-wide changes", "", "These changeset entries appear identically across multiple packages and are listed once.", "");
    for (const g of shared) {
        sharedLines.push(g.entry.text);
        const pkgs = [...g.pkgs].sort();
        sharedLines.push("", `  _Affects: ${pkgs.join(", ")} (${pkgs.length} packages)._`, "");
    }
}

// 3. Package changes — per package, entries unique to that package.
packageLines.push("## Package changes", "");
for (const pkgName of [...perPackage.keys()].sort()) {
    packageLines.push(`### ${pkgName}@${version}`, "");
    const unique = perPackage.get(pkgName).filter((e) => !sharedKeys.has(e.text.trim()));
    if (!unique.length) {
        packageLines.push("No package-specific changes beyond the repo-wide items above.", "");
        continue;
    }
    for (const cat of CATEGORIES) {
        const inCat = unique.filter((e) => e.category === cat);
        if (!inCat.length) continue;
        packageLines.push(`**${cat.replace(" Changes", "")}**`, "");
        for (const e of inCat) packageLines.push(e.text, "");
    }
}

const render = (sections) =>
    `${sections
        .flat()
        .join("\n")
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd()}\n`;
const byteLength = (text) => Buffer.byteLength(text, "utf8");

// Replaces a dropped section. The reader of a pull request must be able to tell
// that a section is missing and where its full text is, not only the CI log.
const omitted = (title) => [
    `## ${title}`,
    "",
    "_Omitted: the complete notes exceed the size limit of this text. The full text is in each package's `CHANGELOG.md` on the release branch and in the draft GitHub Release._",
    "",
];

const sections = [highlightsLines, sharedLines, packageLines];
let result = render(sections);
if (maxBytes !== null && byteLength(result) > maxBytes) {
    const droppable = [
        { index: 2, title: "Package changes" },
        { index: 1, title: "Repo-wide changes" },
    ];
    for (const { index, title } of droppable) {
        if (!sections[index].length) continue;
        sections[index] = omitted(title);
        result = render(sections);
        if (byteLength(result) <= maxBytes) break;
    }
    if (byteLength(result) > maxBytes) {
        console.error(`warning: the output is ${byteLength(result)} bytes, over --max-bytes ${maxBytes}: Highlights alone does not fit and is never cut`);
    }
}

process.stdout.write(result);
