/**
 * The `connectum proto sync` process must end with a non-zero exit code, and say why, when the
 * server lists a service it cannot describe and when it never answers. The other proto-sync tests
 * call the command function and see only a rejected promise; the exit code is set by the CLI
 * entry point, so it is checked here on the built binary, run as a child process.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { Http2Server } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { close, listen, partialReflectionServer, silentServer } from "../helpers/reflectionServers.ts";

const cliBinary = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

interface CliRun {
    /** Exit code of the process; `null` when it was killed by a signal. */
    code: number | null;
    /** Everything the process wrote to stdout and stderr. */
    output: string;
    /** Set when the harness had to kill the process because it outlived `killAfterMs`. */
    killed: boolean;
}

/** Runs the built CLI without a shell and resolves, never rejects, with how it ended. */
function runCli(args: string[], killAfterMs: number): Promise<CliRun> {
    return new Promise((resolve) => {
        execFile(process.execPath, [cliBinary, ...args], { timeout: killAfterMs, killSignal: "SIGKILL" }, (error, stdout, stderr) => {
            const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
            resolve({ code, output: `${stdout}${stderr}`, killed: error?.killed === true });
        });
    });
}

describe("proto sync process exit code", () => {
    let partial: Http2Server;
    let partialUrl: string;
    let silent: Http2Server;
    let silentUrl: string;
    let workdir: string;

    before(async () => {
        assert.ok(existsSync(cliBinary), `the built CLI ${cliBinary} is missing: run the package build before the tests`);
        partial = partialReflectionServer();
        partialUrl = await listen(partial);
        silent = silentServer();
        silentUrl = await listen(silent);
        workdir = mkdtempSync(join(tmpdir(), "connectum-sync-process-"));
    });

    after(async () => {
        await close(partial);
        await close(silent);
        rmSync(workdir, { recursive: true, force: true });
    });

    it("exits non-zero and names the services without a descriptor, generating nothing", async () => {
        const out = join(workdir, "partial-out");
        const run = await runCli(["proto", "sync", "--from", partialUrl, "--out", out], 30_000);

        assert.equal(run.killed, false, `the process hung:\n${run.output}`);
        assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}`);
        assert.match(run.output, /ghost\.v1\.GhostService/);
        assert.match(run.output, /empty\.v1\.EmptyService/);
        assert.equal(existsSync(out), false);
    });

    it("exits non-zero on a dry run against the same server", async () => {
        const run = await runCli(["proto", "sync", "--from", partialUrl, "--out", join(workdir, "dry-out"), "--dry-run"], 30_000);

        assert.equal(run.killed, false, `the process hung:\n${run.output}`);
        assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}`);
        assert.match(run.output, /ghost\.v1\.GhostService/);
    });

    it("exits non-zero, naming the address and the limit, when the server never answers", async () => {
        const run = await runCli(["proto", "sync", "--from", silentUrl, "--out", join(workdir, "silent-out"), "--timeout", "500"], 30_000);

        assert.equal(run.killed, false, `the process outlived the 500 ms limit by far:\n${run.output}`);
        assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}`);
        assert.ok(run.output.includes(silentUrl), `the message must name the server address ${silentUrl}:\n${run.output}`);
        assert.match(run.output, /500 ms/);
    });

    it("gives up on a silent server after 10000 ms when --timeout is not given", async () => {
        // The documented default is a literal here on purpose: reading it from the source would
        // make the test agree with whatever value the source holds. The call really waits out the limit.
        const run = await runCli(["proto", "sync", "--from", silentUrl, "--out", join(workdir, "default-out")], 60_000);

        assert.equal(run.killed, false, `the process did not stop on its own:\n${run.output}`);
        assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}`);
        assert.match(run.output, /timed out after 10000 ms/);
    });

    it("rejects an invalid --timeout with a non-zero exit before connecting", async () => {
        const run = await runCli(["proto", "sync", "--from", "127.0.0.1:1", "--out", join(workdir, "bad-out"), "--timeout", "007"], 30_000);

        assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}`);
        assert.match(run.output, /--timeout must be a positive integer/);
    });

    it("refuses a --timeout above 99999999 before connecting, quoting the maximum", async () => {
        // 100000000 has nine digits: a grpc-timeout header carries at most eight, so no server could take it.
        const run = await runCli(["proto", "sync", "--from", "127.0.0.1:1", "--out", join(workdir, "over-max-out"), "--timeout", "100000000"], 30_000);

        assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}`);
        assert.match(run.output, /--timeout must be a positive integer/);
        assert.ok(run.output.includes("99999999"), `the message must quote the maximum 99999999:\n${run.output}`);
        assert.ok(!run.output.includes("Connecting to"), `the value must be refused before any connection:\n${run.output}`);
    });

    // The guide documents these five flags of `proto sync`; --help is how the built command shows
    // which ones it really defines.
    it("lists every documented flag in --help", async () => {
        const run = await runCli(["proto", "sync", "--help"], 30_000);

        assert.equal(run.code, 0);
        for (const flag of ["--from", "--out", "--template", "--timeout", "--dry-run"]) {
            // The flag must end there: `--dry-runs` does not list `--dry-run`.
            assert.match(run.output, new RegExp(`${flag}(?![\\w-])`), `--help does not list ${flag}:\n${run.output}`);
        }
    });

    it("documents the 10000 ms default in the --timeout help text", async () => {
        const run = await runCli(["proto", "sync", "--help"], 30_000);

        assert.equal(run.code, 0);
        assert.match(run.output, /--timeout/);
        assert.match(run.output, /default: 10000\)/);
    });
});

describe("proto sync process: unknown flags", () => {
    // `--dryrun` used to be dropped, so the command ran the real sync instead of the dry run.
    it("refuses a flag it does not define before connecting, naming it", async () => {
        const run = await runCli(["proto", "sync", "--from", "127.0.0.1:1", "--out", "unused-out", "--dryrun"], 30_000);

        assert.equal(run.killed, false, run.output);
        assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}\n${run.output}`);
        assert.match(run.output, /^Error: connectum proto sync: unknown option --dryrun\. Valid options: .*--dry-run/m, run.output);
        assert.ok(!run.output.includes("Connecting to"), `the flag must be refused before any connection:\n${run.output}`);
    });
});
