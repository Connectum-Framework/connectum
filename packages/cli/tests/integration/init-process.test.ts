/**
 * `connectum init` as a user runs it: the built CLI as a child process. Input that `init` refuses
 * has to end the process with a non-zero exit code, say which input and why, and leave the disk as
 * it was; the exit code is set by the CLI entry point, so the unit tests that call `executeInit`
 * and see only a rejected promise cannot observe it.
 *
 * Every input used here is refused before the base project would be downloaded, so the suite needs
 * no network.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
            // CI is unset on purpose: the refusal must not depend on the environment's non-interactive signal.
            { cwd, env: { PATH: dirname(process.execPath), TMPDIR: join(cwd, "tmp"), HOME: join(cwd, "home") }, timeout: 30_000, killSignal: "SIGKILL" },
            (error, stdout, stderr) => {
                const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
                resolve({ code, output: `${stdout}${stderr}`, killed: error?.killed === true });
            },
        );
    });
}

describe("init process: refused input", () => {
    let root: string;
    let counter = 0;

    /** A fresh, empty working directory (with a private TMPDIR) for one run. */
    function sandbox(): string {
        counter += 1;
        const cwd = join(root, `run-${counter}`);
        mkdirSync(join(cwd, "tmp"), { recursive: true });
        return cwd;
    }

    /** What the run left in the working directory besides the private TMPDIR. */
    function leftover(cwd: string): string[] {
        return readdirSync(cwd).filter((entry) => entry !== "tmp");
    }

    before(() => {
        assert.ok(existsSync(cliBinary), `the built CLI ${cliBinary} is missing: run the package build before the tests`);
        mkdirSync(scratchRoot, { recursive: true });
        root = mkdtempSync(join(scratchRoot, "init-process-"));
    });

    after(() => {
        rmSync(root, { recursive: true, force: true });
    });

    /** Expects a refusal: non-zero exit, no hang, nothing created. */
    function assertRefused(run: CliRun, cwd: string): void {
        assert.equal(run.killed, false, `the process hung:\n${run.output}`);
        assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}\n${run.output}`);
        assert.deepEqual(leftover(cwd), [], `nothing may be created:\n${run.output}`);
    }

    it("refuses a package name that npm would not accept, naming the name and the rule", async () => {
        const cwd = sandbox();
        const run = await runCli(["init", "My-App", "--yes"], cwd);

        assertRefused(run, cwd);
        assert.ok(run.output.includes("My-App"), run.output);
        assert.match(run.output, /lower-case/);
    });

    it("refuses a runtime other than node and bun, listing the accepted values", async () => {
        const cwd = sandbox();
        const run = await runCli(["init", "demo", "--runtime", "deno", "--yes"], cwd);

        assertRefused(run, cwd);
        assert.ok(run.output.includes('"deno"'), run.output);
        assert.match(run.output, /\bnode\b/);
        assert.match(run.output, /\bbun\b/);
    });

    it("refuses a package manager other than pnpm, npm and bun, listing the accepted values", async () => {
        const cwd = sandbox();
        const run = await runCli(["init", "demo", "--package-manager", "yarn", "--yes"], cwd);

        assertRefused(run, cwd);
        assert.ok(run.output.includes('"yarn"'), run.output);
        for (const accepted of ["pnpm", "npm", "bun"]) {
            assert.ok(run.output.includes(accepted), `${accepted} is not listed:\n${run.output}`);
        }
    });

    for (const option of [["--auth"], ["--events", "nats"]]) {
        it(`refuses --no-sample together with ${option[0]}, naming both options`, async () => {
            const cwd = sandbox();
            const run = await runCli(["init", "demo", "--no-sample", ...option, "--yes"], cwd);

            assertRefused(run, cwd);
            assert.ok(run.output.includes("--no-sample"), run.output);
            assert.ok(run.output.includes(option[0] as string), run.output);
        });
    }

    it("refuses --resilience fallback with the hint about adding the handler by hand", async () => {
        const cwd = sandbox();
        const run = await runCli(["init", "demo", "--resilience", "retry,fallback", "--yes"], cwd);

        assertRefused(run, cwd);
        assert.ok(run.output.includes('invalid --resilience "fallback"'), run.output);
        assert.ok(run.output.includes("createFallbackInterceptor({ handler })"), run.output);
    });

    it("refuses to run without a project name when it cannot ask", async () => {
        const cwd = sandbox();
        const run = await runCli(["init", "--yes"], cwd);

        assertRefused(run, cwd);
        assert.match(run.output, /project name is required/);
    });

    it("refuses a non-empty directory without --force and leaves its files untouched", async () => {
        const cwd = sandbox();
        mkdirSync(join(cwd, "taken"));
        writeFileSync(join(cwd, "taken/package.json"), "{}");
        const run = await runCli(["init", "taken", "--yes"], cwd);

        assert.equal(run.killed, false, `the process hung:\n${run.output}`);
        assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}\n${run.output}`);
        assert.match(run.output, /already exists and is not empty/);
        assert.deepEqual(readdirSync(join(cwd, "taken")), ["package.json"]);
        assert.equal(readFileSync(join(cwd, "taken/package.json"), "utf8"), "{}");
    });
});

describe("init process: --help", () => {
    // The guide's flag table is the list of flags `init` has; every interactive choice has one.
    it("lists every flag of the guide", async () => {
        mkdirSync(scratchRoot, { recursive: true });
        const cwd = mkdtempSync(join(scratchRoot, "init-help-"));
        mkdirSync(join(cwd, "tmp"));
        try {
            const run = await runCli(["init", "--help"], cwd);

            assert.equal(run.code, 0, run.output);
            for (const flag of [
                "--runtime",
                "--package-manager",
                "--node-exec",
                "--otel",
                "--events",
                "--auth",
                "--catalog",
                "--resilience",
                "--healthcheck",
                "--reflection",
                "--sample",
                "--yes",
                "--force",
                "--ref",
            ]) {
                // The flag must end there: `--catalogue` does not list `--catalog`.
                assert.match(run.output, new RegExp(`${flag}(?![\\w-])`), `--help does not list ${flag}:\n${run.output}`);
            }
        } finally {
            rmSync(cwd, { recursive: true, force: true });
        }
    });
});
