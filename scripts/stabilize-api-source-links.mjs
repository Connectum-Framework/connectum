#!/usr/bin/env node
/**
 * Stabilize the generated API-reference source links.
 *
 * TypeDoc embeds the current git HEAD commit SHA in every "Defined in:" source
 * link. That makes each regen rewrite all ~900 files (SHA churn), and a regen on
 * a feature branch pins links to a commit that squash-merge later orphans
 * (eventual 404s). Configuring TypeDoc's `disableGit` + `sourceLinkTemplate` to
 * avoid this also restructures the per-package output (it shifts `{path}`
 * rooting), so instead we post-process: replace the volatile
 * `/blob/<40-hex-sha>/` with the stable `/blob/main/`.
 *
 * Run automatically by `pnpm docs:api` (after `typedoc`).
 *
 * @module scripts/stabilize-api-source-links
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const API_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "en", "api");

/** Volatile source-link revision: `/blob/<40 hex>/` → stable `/blob/main/`. */
const SHA_LINK = /\/blob\/[0-9a-f]{40}\//g;
const STABLE = "/blob/main/";

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

let scanned = 0;
let rewritten = 0;
for (const file of markdownFiles(API_DIR)) {
    scanned += 1;
    const before = readFileSync(file, "utf8");
    const after = before.replace(SHA_LINK, STABLE);
    if (after !== before) {
        writeFileSync(file, after);
        rewritten += 1;
    }
}

console.log(`stabilize-api-source-links: pinned source links to ${STABLE} in ${rewritten}/${scanned} files`);
