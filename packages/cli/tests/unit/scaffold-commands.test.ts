/**
 * Tests for the scaffolding command seam.
 *
 * `init` runs the real fetch→transform→emit pipeline against an injected local
 * clone stub (no network). `generate service` is still a Phase-3 work-in-progress
 * stub and this locks its honest contract.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { executeGenerateService, generateServiceCommand } from "../../src/commands/generate-service.ts";
import { executeInit, initCommand } from "../../src/commands/init.ts";
import type { CloneFn } from "../../src/scaffold/fetchBase.ts";

/** A clone stub that writes a minimal getting-started-shaped base into `dest`. */
const cloneStub: CloneFn = async (_source, dest) => {
    mkdirSync(join(dest, "src/services"), { recursive: true });
    mkdirSync(join(dest, "tests/e2e"), { recursive: true });
    writeFileSync(
        join(dest, "package.json"),
        JSON.stringify(
            {
                name: "@connectum/example-getting-started",
                private: true,
                type: "module",
                imports: { "#gen/*": "./gen/*", "#*": "./src/*" },
                scripts: { start: "node src/index.ts" },
                dependencies: { "@connectum/core": "^1.0.0" },
                devDependencies: { "@bufbuild/buf": "^1.65.0", "@connectrpc/connect-node": "^2.1.1", typescript: "^5.9.3" },
                engines: { node: ">=25.2.0" },
            },
            null,
            2,
        ),
    );
    writeFileSync(join(dest, "pnpm-workspace.yaml"), "packages: []\n");
    writeFileSync(join(dest, "src/services/greeterService.ts"), "export const greeterService = {};\n");
    writeFileSync(join(dest, "tests/e2e/e2e.test.ts"), "// old test using createGrpcTransport\n");
    writeFileSync(join(dest, "buf.gen.yaml"), "version: v2\n");
};

describe("init command", () => {
    it("exports a citty command with a run handler", () => {
        assert.equal(typeof initCommand.run, "function");
    });
});

describe("executeInit pipeline (injected clone, no network)", () => {
    let workdir: string;
    let cwd: string;

    beforeEach(() => {
        cwd = process.cwd();
        workdir = mkdtempSync(join(tmpdir(), "connectum-init-work-"));
        process.chdir(workdir);
    });

    afterEach(() => {
        process.chdir(cwd);
        rmSync(workdir, { recursive: true, force: true });
    });

    it("scaffolds a project from the base", async () => {
        await executeInit({ name: "myservice", clone: cloneStub });
        const pkg = JSON.parse(readFileSync(join(workdir, "myservice/package.json"), "utf8"));
        assert.equal(pkg.name, "myservice");
        assert.equal(pkg.private, undefined);
        // pnpm (default) gets a standalone pnpm-workspace.yaml with the buf build-approval.
        assert.match(readFileSync(join(workdir, "myservice/pnpm-workspace.yaml"), "utf8"), /onlyBuiltDependencies/);
        assert.match(readFileSync(join(workdir, "myservice/tests/e2e/e2e.test.ts"), "utf8"), /createLocalClient/);
        assert.equal(pkg.devDependencies["@connectum/testing"], "^1.0.0");
    });

    it("refuses to clobber a non-empty target directory", async () => {
        mkdirSync(join(workdir, "taken"), { recursive: true });
        writeFileSync(join(workdir, "taken/package.json"), "{}");
        await assert.rejects(() => executeInit({ name: "taken", clone: cloneStub }), /already exists and is not empty/);
    });

    it("rejects an invalid runtime before doing any work", async () => {
        await assert.rejects(() => executeInit({ name: "x", runtime: "deno", clone: cloneStub }), /invalid --runtime/);
    });
});

describe("generate service command seam (Phase 3 work in progress)", () => {
    it("exports a citty command with a run handler", () => {
        assert.equal(typeof generateServiceCommand.run, "function");
    });

    it("executeGenerateService rejects with a clear work-in-progress message", async () => {
        await assert.rejects(() => executeGenerateService({ name: "billing" }), /not yet functional/);
    });
});
