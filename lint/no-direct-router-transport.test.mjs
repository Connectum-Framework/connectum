/**
 * Proves that the Biome GritQL plugin `lint/no-direct-router-transport.grit`,
 * wired through the real `biome.json`, fires on every form of reference to
 * `createRouterTransport` in package sources and stays silent on the two files
 * allowed to use it.
 *
 * Why a test: the rule is a security guard (a raw router transport skips the
 * server interceptor chain), and its failure mode is silence. Two things can
 * make it silently stop firing: the plugin `includes` globs stop matching (with
 * Biome 2.5 plain relative globs match nothing, only `**`-prefixed ones do), or
 * a Biome upgrade changes how the pattern binds. Either would leave `pnpm lint`
 * green while the guard is gone; this test turns that into a red build.
 *
 * Fixtures are written under `.tmp/` with the same `packages/<pkg>/src/...`
 * layout as the real sources, so the real plugin globs apply to them unchanged.
 * `.tmp/` is git-ignored, hence `--vcs-use-ignore-file=false`. Every fixture
 * also carries a `debugger` statement: its `noDebugger` diagnostic proves Biome
 * actually linted the file, so "no plugin diagnostic" on an allowed file cannot
 * pass just because the file was skipped.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every reference form the rule must flag, one per line (1-based line numbers below). */
const VIOLATING_SOURCE = [
    "// createRouterTransport in a comment is not a reference",
    'import * as connect from "@connectrpc/connect";',
    'import { createRouterTransport } from "@connectrpc/connect";',
    'import { createRouterTransport as routerTransport } from "@connectrpc/connect";',
    "export const viaNamespace = connect.createRouterTransport(() => {});",
    "export const viaAlias = routerTransport(() => {});",
    "export const viaDirectCall = createRouterTransport(() => {});",
    'export const inString = "createRouterTransport";',
    'export const viaDynamicImport = async () => (await import("@connectrpc/connect")).createRouterTransport(() => {});',
    "debugger;",
    "",
].join("\n");

/**
 * Lines of {@link VIOLATING_SOURCE} that must carry a plugin diagnostic: the
 * named import, the aliased import, the namespace member, the direct call and
 * the dynamic-import member. The comment (1), the call through the alias (6,
 * already caught at its import) and the string literal (8) must not.
 */
const EXPECTED_VIOLATION_LINES = [3, 4, 5, 7, 9];

const ALLOWED_SOURCE = ['import { createRouterTransport } from "@connectrpc/connect";', "export const transport = createRouterTransport(() => {});", "debugger;", ""].join("\n");

const FIXTURES = {
    coreViolation: { path: "packages/core/src/violation.ts", source: VIOLATING_SOURCE },
    otherPackageViolation: { path: "packages/otel/src/violation.ts", source: VIOLATING_SOURCE },
    coreLocalTransport: { path: "packages/core/src/localTransport.ts", source: ALLOWED_SOURCE },
    testingMockResolver: { path: "packages/testing/src/mockResolver.ts", source: ALLOWED_SOURCE },
    outsideSources: { path: "packages/core/scripts/tool.ts", source: ALLOWED_SOURCE },
};

/** @type {string} */
let fixtureRoot;
/** @type {Map<string, Array<{ category: string; line: number }>>} */
const diagnosticsByFile = new Map();

function diagnosticsFor(fixture) {
    const key = relative(repoRoot, join(fixtureRoot, fixture.path));
    const diagnostics = diagnosticsByFile.get(key);
    assert.ok(diagnostics, `Biome reported nothing for ${key}; the file was not linted, so the result below would be vacuous`);
    assert.ok(
        diagnostics.some((d) => d.category === "lint/suspicious/noDebugger"),
        `${key} lacks its noDebugger diagnostic, so Biome did not lint it with the repository configuration`,
    );
    return diagnostics.filter((d) => d.category === "plugin");
}

describe("biome plugin: no direct createRouterTransport", () => {
    before(() => {
        mkdirSync(join(repoRoot, ".tmp"), { recursive: true });
        fixtureRoot = mkdtempSync(join(repoRoot, ".tmp", "router-transport-rule-"));
        for (const fixture of Object.values(FIXTURES)) {
            const file = join(fixtureRoot, fixture.path);
            mkdirSync(dirname(file), { recursive: true });
            writeFileSync(file, fixture.source);
        }

        const biome = spawnSync("pnpm", ["exec", "biome", "lint", "--vcs-use-ignore-file=false", "--reporter=json", relative(repoRoot, fixtureRoot)], {
            cwd: repoRoot,
            encoding: "utf8",
        });
        assert.ok(biome.stdout, `biome produced no JSON report (exit ${biome.status}): ${biome.stderr}`);
        const report = JSON.parse(biome.stdout);
        for (const diagnostic of report.diagnostics) {
            const file = diagnostic.location?.path;
            if (!file) continue;
            const list = diagnosticsByFile.get(file) ?? [];
            list.push({ category: diagnostic.category, line: diagnostic.location.start.line });
            diagnosticsByFile.set(file, list);
        }
    });

    after(() => {
        if (fixtureRoot) rmSync(fixtureRoot, { recursive: true, force: true });
    });

    it("flags every reference form in a core source file", () => {
        const lines = diagnosticsFor(FIXTURES.coreViolation).map((d) => d.line);
        assert.deepEqual(lines.sort((a, b) => a - b), EXPECTED_VIOLATION_LINES);
    });

    it("flags the same forms in any other package", () => {
        const lines = diagnosticsFor(FIXTURES.otherPackageViolation).map((d) => d.line);
        assert.deepEqual(lines.sort((a, b) => a - b), EXPECTED_VIOLATION_LINES);
    });

    it("allows the core in-process transport, which wires the server interceptors in", () => {
        assert.deepEqual(diagnosticsFor(FIXTURES.coreLocalTransport), []);
    });

    it("allows the mock resolver of @connectum/testing, which serves mock services without a server", () => {
        assert.deepEqual(diagnosticsFor(FIXTURES.testingMockResolver), []);
    });

    it("does not reach files outside package src directories", () => {
        assert.deepEqual(diagnosticsFor(FIXTURES.outsideSources), []);
    });
});
