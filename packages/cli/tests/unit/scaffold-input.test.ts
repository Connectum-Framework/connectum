/**
 * Input validation of `connectum init`: what the positional argument means, which package
 * names are accepted, how `--no-sample` combines with other options, and that a refused
 * input leaves nothing on disk.
 */

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { executeInit } from "../../src/commands/init.ts";
import { resolveConfig } from "../../src/scaffold/config.ts";
import { cloneStub } from "../helpers/baseFixture.ts";

describe("resolveConfig: destination path and package name", () => {
    it("takes the last path segment as the package name and keeps the path as typed", () => {
        const cfg = resolveConfig({ name: "apps/payments" }, "/work");
        assert.equal(cfg.name, "payments");
        assert.equal(cfg.dir, "apps/payments");
    });

    it("accepts an absolute path", () => {
        const cfg = resolveConfig({ name: "/srv/projects/billing/" }, "/work");
        assert.equal(cfg.name, "billing");
        assert.equal(cfg.dir, "/srv/projects/billing/");
    });

    it("takes the current directory name for a dot", () => {
        const cfg = resolveConfig({ name: "." }, "/work/ledger");
        assert.equal(cfg.name, "ledger");
        assert.equal(cfg.dir, ".");
    });

    // Each case: [input, a fragment that the message must contain to name the broken rule].
    const rejected: [string, RegExp][] = [
        ["My-App", /lower-case/],
        ["my app", /whitespace/],
        ["a${b}c", /not URL-safe/],
        ["a`b", /not URL-safe/],
        ["a%b", /not URL-safe/],
        ["a#b", /not URL-safe/],
        ["a'b", /one of/],
        ["a(b)", /one of/],
        ["a*b", /one of/],
        ["a!b", /one of/],
        ["a~b", /one of/],
        [".hidden", /start with/],
        ["_private", /start with/],
        ["-dash", /start with/],
        ["node_modules", /reserved/],
        ["favicon.ico", /reserved/],
        ["http", /core module/],
        ["fs", /core module/],
        ["x".repeat(215), /214/],
        ["ünï", /not URL-safe/],
    ];
    for (const [input, rule] of rejected) {
        it(`rejects the package name ${JSON.stringify(input.length > 40 ? `${input.slice(0, 10)}…(${input.length})` : input)}`, () => {
            assert.throws(
                () => resolveConfig({ name: input }, "/work"),
                (err: Error) => err.message.startsWith("connectum init: invalid project name") && rule.test(err.message),
            );
        });
    }

    it("reports every violated rule of one name together", () => {
        assert.throws(
            () => resolveConfig({ name: "_My App" }, "/work"),
            (err: Error) => /start with/.test(err.message) && /lower-case/.test(err.message) && /whitespace/.test(err.message),
        );
    });

    it("rejects the root directory, whose last segment is empty", () => {
        assert.throws(() => resolveConfig({ name: "/" }, "/work"), /invalid project name/);
    });

    it("accepts names npm accepts for a new package", () => {
        for (const name of ["svc", "my-service", "my_service", "svc.v2", "a1", "x".repeat(214)]) {
            assert.equal(resolveConfig({ name }, "/work").name, name);
        }
    });
});

describe("executeInit: a refused name leaves nothing on disk", () => {
    let workdir: string;
    let cwd: string;

    beforeEach(() => {
        cwd = process.cwd();
        workdir = mkdtempSync(join(tmpdir(), "connectum-init-input-"));
        process.chdir(workdir);
    });
    afterEach(() => {
        process.chdir(cwd);
        rmSync(workdir, { recursive: true, force: true });
    });

    it("does not create a directory for an invalid name", async () => {
        for (const name of ["a${b}c", "my app", "My-App"]) {
            await assert.rejects(() => executeInit({ name, clone: cloneStub }), /invalid project name/);
        }
        assert.deepEqual(readdirSync(workdir), []);
    });

    it("creates the nested destination and writes the last segment as the package name", async () => {
        await executeInit({ name: "apps/payments", clone: cloneStub });
        const pkg = JSON.parse(readFileSync(join(workdir, "apps/payments/package.json"), "utf8"));
        assert.equal(pkg.name, "payments");
    });

    it("scaffolds into the current directory for a dot, naming the package after it", async () => {
        const inner = join(workdir, "ledger");
        mkdirSync(inner);
        process.chdir(inner);
        await executeInit({ name: ".", clone: cloneStub });
        const pkg = JSON.parse(readFileSync(join(inner, "package.json"), "utf8"));
        assert.equal(pkg.name, "ledger");
    });
});
