/**
 * Tests for the scaffolding command seam.
 *
 * `init` runs the real fetch→transform→emit pipeline against an injected local
 * clone stub (no network). `generate service` emits a starter proto plus a
 * `defineService` skeleton, and these lock its input validation and output shape.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { executeGenerateService, generateServiceCommand } from "../../src/commands/generate-service.ts";
import { executeInit, initCommand } from "../../src/commands/init.ts";
import type { CloneFn } from "../../src/scaffold/fetchBase.ts";
import { DEFAULT_BASE_REF } from "../../src/scaffold/fetchBase.ts";

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
        assert.match(readFileSync(join(workdir, "myservice/pnpm-workspace.yaml"), "utf8"), /allowBuilds:/);
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

    it("fails clearly when the target path exists as a file (not a raw ENOTDIR)", async () => {
        writeFileSync(join(workdir, "afile"), "x");
        await assert.rejects(() => executeInit({ name: "afile", clone: cloneStub }), /is not a directory/);
    });

    it("fetches a pinned tag by default, not a moving branch", async () => {
        // A published CLI is immutable but its base is not: the module fragments
        // transform the fetched text, so a moving default ref would let an edit on
        // examples/main break `init` for every already-released CLI version.
        assert.notEqual(DEFAULT_BASE_REF, "main");
        assert.match(DEFAULT_BASE_REF, /^v\d+\.\d+\.\d+$/);

        const seen: string[] = [];
        const recordingClone: CloneFn = async (source, dest) => {
            seen.push(source);
            await cloneStub(source, dest);
        };
        await executeInit({ name: "pinned", clone: recordingClone });
        assert.deepStrictEqual(seen, [`Connectum-Framework/examples/getting-started#${DEFAULT_BASE_REF}`]);
    });

    it("honours an explicit --ref override", async () => {
        const seen: string[] = [];
        const recordingClone: CloneFn = async (source, dest) => {
            seen.push(source);
            await cloneStub(source, dest);
        };
        await executeInit({ name: "overridden", clone: recordingClone, ref: "main" });
        assert.deepStrictEqual(seen, ["Connectum-Framework/examples/getting-started#main"]);
    });
});

describe("executeGenerateService", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "connectum-gensvc-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("exports a citty command with a run handler", () => {
        assert.equal(typeof generateServiceCommand.run, "function");
    });

    it("scaffolds a proto + defineService skeleton (throwing Unimplemented, D-6)", async () => {
        await executeGenerateService({ name: "billing", cwd: dir });
        assert.match(readFileSync(join(dir, "proto/billing/v1/billing.proto"), "utf8"), /service BillingService/);
        const impl = readFileSync(join(dir, "src/services/billingService.ts"), "utf8");
        assert.match(impl, /defineService\(BillingService/);
        assert.match(impl, /Code\.Unimplemented/);
    });

    it("with --with-events emits the event-handler proto + vendored option proto", async () => {
        await executeGenerateService({ name: "orders", withEvents: true, cwd: dir });
        assert.match(readFileSync(join(dir, "proto/orders/v1/orders.proto"), "utf8"), /service OrdersEventHandlers/);
        assert.match(readFileSync(join(dir, "src/services/ordersService.ts"), "utf8"), /EventRoute/);
        assert.ok(existsSync(join(dir, "proto/connectum/events/v1/options.proto")));
    });

    it("rejects a service name that starts with a digit", async () => {
        // "123-orders" normalizes to "123orders": a proto package must start with a
        // letter, and the derived TS binding `123OrdersService` would not even parse.
        for (const name of ["123", "123-orders", "0a"]) {
            await assert.rejects(() => executeGenerateService({ name, cwd: dir }), /must start with a letter/);
        }
    });

    it("rejects a service name with no alphanumeric characters", async () => {
        await assert.rejects(() => executeGenerateService({ name: "!!!", cwd: dir }), /must start with a letter/);
    });

    it("refuses to clobber and requires a name", async () => {
        await assert.rejects(() => executeGenerateService({ name: "  ", cwd: dir }), /service name is required/);
        await executeGenerateService({ name: "billing", cwd: dir });
        // Second run without force skips existing files (no throw).
        await executeGenerateService({ name: "billing", cwd: dir });
    });
});
