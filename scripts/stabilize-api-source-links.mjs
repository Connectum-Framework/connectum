#!/usr/bin/env node
/**
 * Stabilize source links in the generated API reference.
 *
 * TypeDoc embeds the current git HEAD commit SHA in linked source references.
 * That makes regeneration rewrite generated pages and pins links to commits
 * that may disappear after squash merges. TypeDoc 0.28 can also emit plain
 * `Defined in: packages/.../file.ts:line` references when the framework is a
 * git worktree. Rewrite those only when the exact source path is tracked.
 *
 * Run automatically by `pnpm docs:api` after `typedoc`.
 *
 * @module scripts/stabilize-api-source-links
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const FRAMEWORK_ROOT = resolve(SCRIPT_DIR, "..");
const API_DIR = join(FRAMEWORK_ROOT, "..", "docs", "en", "api");

/** Volatile source-link revision: `/blob/<40 hex>/` → stable `/blob/main/`. */
const SHA_LINK = /\/blob\/[0-9a-f]{40}\//g;
const STABLE = "/blob/main/";
const DEFINED_IN = /^([ \t]{0,3})Defined in: ([^\s:]+):([1-9]\d*)([ \t]*)$/;

/** Recursively yield every `.md` file under `dir`. */
function* markdownFiles(dir) {
    for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
            yield* markdownFiles(full);
        } else if (entry.endsWith(".md")) {
            yield full;
        }
    }
}

/**
 * Rewrite TypeDoc source references outside fenced code blocks.
 *
 * `trackedPaths` must be the repository's exact `git ls-files` paths, so a
 * source-looking reference to generated or dependency files remains prose.
 */
function sourcePathFor(displayPath, packageName, trackedPaths) {
    const lookupPath = displayPath.replaceAll("\\_", "_");
    if (lookupPath.startsWith("packages/")) {
        return trackedPaths.has(lookupPath) ? lookupPath : null;
    }

    if (!packageName || lookupPath.startsWith("/") || lookupPath.split("/").some((part) => part === "." || part === "..")) {
        return null;
    }

    let packageRelativePath;
    if (lookupPath.startsWith(`${packageName}/src/`)) {
        packageRelativePath = lookupPath.slice(packageName.length + "/src/".length);
        packageRelativePath = `packages/${packageName}/src/${packageRelativePath}`;
    } else if (lookupPath.startsWith("src/")) {
        packageRelativePath = `packages/${packageName}/${lookupPath}`;
    } else {
        packageRelativePath = `packages/${packageName}/src/${lookupPath}`;
    }

    return trackedPaths.has(packageRelativePath) ? packageRelativePath : null;
}

function packageNameForApiFile(file) {
    const [scope, packageName] = relative(API_DIR, file).split(sep);
    if (scope !== "@connectum" || !/^[a-z0-9-]+$/.test(packageName ?? "")) return null;
    return packageName;
}

export function stabilizeSourceLinks(markdown, trackedPaths, packageName = null) {
    const tracked = trackedPaths instanceof Set ? trackedPaths : new Set(trackedPaths);
    const parts = markdown.replace(SHA_LINK, STABLE).split(/(\r?\n)/);
    let fence = null;

    for (let index = 0; index < parts.length; index += 2) {
        const line = parts[index];
        const fenceMarker = line.match(/^ {0,3}(`{3,}|~{3,})/);

        if (fence) {
            if (fenceMarker) {
                const closing = new RegExp(`^ {0,3}${fence.character}{${fence.length},}\\s*$`);
                if (closing.test(line)) fence = null;
            }
            continue;
        }

        if (fenceMarker) {
            const marker = fenceMarker[1];
            fence = { character: marker[0], length: marker.length };
            continue;
        }

        const definition = line.match(DEFINED_IN);
        if (!definition) continue;

        const [, indent, displayPath, lineNumber, trailingWhitespace] = definition;
        const sourcePath = sourcePathFor(displayPath, packageName, tracked);
        if (!sourcePath) continue;

        const url = `https://github.com/Connectum-Framework/connectum/blob/main/${sourcePath}#L${lineNumber}`;
        parts[index] = `${indent}Defined in: [${displayPath}:${lineNumber}](${url})${trailingWhitespace}`;
    }

    return parts.join("");
}

function trackedFrameworkFiles() {
    const output = execFileSync("git", ["ls-files", "-z"], {
        cwd: FRAMEWORK_ROOT,
        encoding: "buffer",
        stdio: ["ignore", "pipe", "inherit"],
    });
    return new Set(output.toString("utf8").split("\0").filter(Boolean));
}

function main() {
    const trackedPaths = trackedFrameworkFiles();
    let scanned = 0;
    let rewritten = 0;

    for (const file of markdownFiles(API_DIR)) {
        scanned += 1;
        const before = readFileSync(file, "utf8");
        const after = stabilizeSourceLinks(before, trackedPaths, packageNameForApiFile(file));
        if (after !== before) {
            writeFileSync(file, after);
            rewritten += 1;
        }
    }

    console.log(`stabilize-api-source-links: pinned source links to ${STABLE} and linked tracked definitions in ${rewritten}/${scanned} files`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
