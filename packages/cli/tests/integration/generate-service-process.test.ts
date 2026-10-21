/**
 * `connectum generate service` as a user runs it: the built CLI as a child process. A refused name
 * has to end the process with a non-zero exit code, say which name and which rule, and leave the
 * directory as it was; the exit code is set by the CLI entry point, so the unit tests that call
 * `executeGenerateService` and see only a rejected promise cannot observe it.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const cliBinary = fileURLToPath(new URL("../../dist/index.js", import.meta.url));
/** Gitignored scratch area of the repository, so no test writes outside it. */
const scratchRoot = fileURLToPath(new URL("../../../../.tmp/", import.meta.url));

interface CliRun {
    /** Exit code of the process; `null` when it was killed by a signal. */
    code: number | null;
    /** Everything the process wrote to stdout and stderr. */
    output: string;
    /** Set when the harness had to kill the process because it outlived the allowed time. */
    killed: boolean;
}

/** Runs the built CLI without a shell and resolves, never rejects, with how it ended. */
function runCli(args: string[], cwd: string): Promise<CliRun> {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            [cliBinary, ...args],
            { cwd, env: { PATH: dirname(process.execPath), TMPDIR: cwd, HOME: cwd }, timeout: 30_000, killSignal: "SIGKILL" },
            (error, stdout, stderr) => {
                const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
                resolve({ code, output: `${stdout}${stderr}`, killed: error?.killed === true });
            },
        );
    });
}

describe("generate service process: refused names", () => {
    let root: string;
    let counter = 0;

    /** A fresh, empty project directory for one run. */
    function project(): string {
        counter += 1;
        const cwd = join(root, `run-${counter}`);
        mkdirSync(cwd, { recursive: true });
        return cwd;
    }

    before(() => {
        assert.ok(existsSync(cliBinary), `the built CLI ${cliBinary} is missing: run the package build before the tests`);
        mkdirSync(scratchRoot, { recursive: true });
        root = mkdtempSync(join(scratchRoot, "generate-service-process-"));
    });

    after(() => {
        rmSync(root, { recursive: true, force: true });
    });

    /** Expects a refusal: non-zero exit, no hang, the name and the rule in the output, nothing created. */
    function assertRefused(run: CliRun, cwd: string, name: string, rule: RegExp): void {
        assert.equal(run.killed, false, `the process hung:\n${run.output}`);
        assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}\n${run.output}`);
        assert.ok(run.output.includes(`"${name}"`), `the output must name the name:\n${run.output}`);
        assert.match(run.output, rule);
        assert.deepEqual(readdirSync(cwd), [], `nothing may be created:\n${run.output}`);
    }

    it("refuses a name that climbs out of the directory", async () => {
        const cwd = project();
        const run = await runCli(["generate", "service", "../x"], cwd);
        assertRefused(run, cwd, "../x", /only ASCII letters, digits, "-" and "_" are allowed/);
    });

    it("refuses a name with Cyrillic letters instead of dropping them", async () => {
        const cwd = project();
        const run = await runCli(["generate", "service", "Привет-billing"], cwd);
        assertRefused(run, cwd, "Привет-billing", /only ASCII letters, digits, "-" and "_" are allowed/);
    });

    it("refuses a name with a space", async () => {
        const cwd = project();
        const run = await runCli(["generate", "service", "Order Service"], cwd);
        assertRefused(run, cwd, "Order Service", /only ASCII letters, digits, "-" and "_" are allowed/);
    });

    it("refuses a name that starts with a digit", async () => {
        const cwd = project();
        const run = await runCli(["generate", "service", "123-orders"], cwd);
        assertRefused(run, cwd, "123-orders", /must start with a letter/);
    });

    it("refuses an over-long name with the limit, not with a system error", async () => {
        const cwd = project();
        const name = "a".repeat(215);
        const run = await runCli(["generate", "service", name], cwd);
        assertRefused(run, cwd, name, /longer than 214 characters/);
        assert.ok(!run.output.includes("ENAMETOOLONG"), run.output);
    });

    it("refuses a name whose proto belongs to another service and keeps the project as it was", async () => {
        const cwd = project();
        const first = await runCli(["generate", "service", "ab"], cwd);
        assert.equal(first.code, 0, first.output);

        const second = await runCli(["generate", "service", "a-b"], cwd);

        assert.equal(second.killed, false, second.output);
        assert.ok(second.code !== null && second.code !== 0, `expected a non-zero exit code, got ${second.code}\n${second.output}`);
        assert.ok(second.output.includes("proto/ab/v1/ab.proto") && second.output.includes("ABService"), second.output);
        assert.equal(existsSync(join(cwd, "src/services/aBService.ts")), false);
    });
});
