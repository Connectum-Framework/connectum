/**
 * Pin the packaging invariant of the dual-entry build (#203): the /testing
 * subpath and the main barrel must share ONE copy of the error classes.
 * Without tsup `splitting: true` each bundle gets its own errors.ts copy and
 * `instanceof` breaks across the boundary in the PUBLISHED package — the
 * exact failure this test guards against. Runs against dist/ (built before
 * tests by the turbo pipeline).
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

describe("dist packaging parity (#203)", () => {
    it("errors thrown by dist/testing.js are instanceof the classes exported by dist/index.js", async () => {
        const testing = await import("../../dist/testing.js");
        const barrel = await import("../../dist/index.js");

        const fake = testing.FakeAmqpAdapter();
        await assert.rejects(
            () => fake.publish("x", new Uint8Array()),
            (err: unknown) => {
                assert.ok(err instanceof barrel.AmqpConnectionError, "instanceof must hold across the subpath boundary (shared chunk, not a duplicated class)");
                return true;
            },
        );
    });
});

describe("the published entry points", () => {
    it("the ./testing subpath resolves through the package exports map to the built testing entry", async () => {
        // Self-reference by package name goes through `exports`, exactly like a
        // consumer's import; a missing or mistyped `./testing` entry fails here.
        const bySubpath = await import("@connectum/events-amqp/testing");
        const byFile = await import("../../dist/testing.js");
        assert.equal(bySubpath.FakeAmqpAdapter, byFile.FakeAmqpAdapter, "the subpath is the very module dist/testing.js, not a copy");

        const barrel = await import("../../dist/index.js");
        const fake = bySubpath.FakeAmqpAdapter();
        await assert.rejects(
            () => fake.publish("x", new Uint8Array()),
            (err: unknown) => err instanceof barrel.AmqpConnectionError,
        );
    });

    it("the declaration file of the main entry exports AmqpTopologyObject", () => {
        // The documented type for AmqpTopologyError.object must be importable
        // from the package root, not only reachable through the error class.
        const declarations = readFileSync(new URL("../../dist/index.d.ts", import.meta.url), "utf8");
        const exportStatement = declarations.split("\n").find((line) => line.startsWith("export {") && line.includes("AmqpTopologyError"));
        assert.ok(exportStatement, "dist/index.d.ts has an export list naming AmqpTopologyError");
        assert.match(exportStatement, /\bas AmqpTopologyObject\b/);
    });

    it("loading the testing entry pulls in neither amqplib nor node:test", { skip: process.versions.bun !== undefined && "needs Node's module bookkeeping" }, async () => {
        // The fake is advertised as usable without a broker client installed and
        // without dragging the test runner into application code.
        const script = [
            'const { createRequire } = await import("node:module");',
            `await import(${JSON.stringify(new URL("../../dist/testing.js", import.meta.url).href)});`,
            "const loadedClients = Object.keys(createRequire(process.cwd() + '/').cache).filter((file) => file.includes('/amqplib/'));",
            "const loadedRunner = process.moduleLoadList.filter((name) => name === 'NativeModule test' || name.startsWith('NativeModule internal/test_runner/'));",
            "console.log(JSON.stringify({ loadedClients, loadedRunner }));",
        ].join("\n");
        const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "--eval", script]);
        assert.deepEqual(JSON.parse(stdout), { loadedClients: [], loadedRunner: [] });
    });
});
