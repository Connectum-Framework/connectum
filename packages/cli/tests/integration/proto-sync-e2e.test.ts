/**
 * `connectum proto sync` as a user runs it: the built CLI as a child process against a real
 * Connectum server, with the real `buf` and `protoc-gen-es` from this package's devDependencies.
 *
 * The unit tests of the command replace the network, `buf` and the file system with mocks and can
 * only compare the arguments the code passes on. Here the judges are observable results: the files
 * `buf` writes, the exit code of the process, what is left in the temporary directory, and the
 * messages the user reads. `buf`'s documented behaviour is the oracle for the generation part: the
 * `--template` flag selects the template (default `buf.gen.yaml` in the working directory) and
 * `--output` is the base directory of the generated files.
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import type { Server } from "@connectum/core";
import { createServer } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { Reflection } from "@connectum/reflection";

const cliRoot = fileURLToPath(new URL("../../", import.meta.url));
const cliBinary = join(cliRoot, "dist/index.js");
/** `buf` and `protoc-gen-es`, as they sit on the PATH of a project that depends on the CLI. */
const toolBin = join(cliRoot, "node_modules/.bin");
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

/**
 * Runs the built CLI without a shell and resolves, never rejects, with how it ended.
 * `tmpdir` becomes the `TMPDIR` of the child, so whatever the command leaves behind in the
 * system temporary directory lands in a directory this test can inspect.
 */
function runCli(args: string[], options: { cwd: string; tmpdir: string; path: string }): Promise<CliRun> {
    return new Promise((resolve) => {
        execFile(
            process.execPath,
            [cliBinary, ...args],
            { cwd: options.cwd, env: { PATH: options.path, TMPDIR: options.tmpdir, HOME: join(options.cwd, "home") }, timeout: 60_000, killSignal: "SIGKILL" },
            (error, stdout, stderr) => {
                const code = error === null ? 0 : typeof error.code === "number" ? error.code : null;
                resolve({ code, output: `${stdout}${stderr}`, killed: error?.killed === true });
            },
        );
    });
}

/** A privileged port below the ephemeral range: nothing in this test run can listen on it. */
const UNBINDABLE_PORT = 1;

/**
 * Resolves with the error code of a connection attempt to `127.0.0.1:port`, or `"connected"`.
 * The tests below rely on port 1 refusing connections; checking it once up front turns a host
 * that happens to serve something there into a clear failure instead of a puzzling mismatch.
 */
function probeLoopbackPort(port: number): Promise<string> {
    return new Promise((resolve) => {
        // A host that drops packets to the port would otherwise leave the attempt pending forever.
        const socket = connect({ host: "127.0.0.1", port, timeout: 5_000 });
        socket.once("connect", () => {
            socket.destroy();
            resolve("connected");
        });
        socket.once("timeout", () => {
            socket.destroy();
            resolve("timeout");
        });
        socket.once("error", (error: NodeJS.ErrnoException) => resolve(error.code ?? error.message));
    });
}

const PLUGIN_TEMPLATE =(out: string): string => ["version: v2", "plugins:", "  - local: protoc-gen-es", `    out: ${out}`, "    opt: target=ts", ""].join("\n");

describe("proto sync as a process, with real buf", () => {
    let server: Server;
    /** A server created the way the framework's docs create one: `allowHTTP1` left at its default. */
    let http1Server: Server;
    let http1Port: number;
    let port: number;
    let closedPort: number;
    let workdir: string;
    let counter = 0;

    /** A fresh working directory, output location and private TMPDIR for one run. */
    function sandbox(): { cwd: string; out: string; tmp: string } {
        counter += 1;
        const cwd = join(workdir, `run-${counter}`);
        const tmp = join(cwd, "tmp");
        mkdirSync(tmp, { recursive: true });
        return { cwd, out: join(cwd, "out"), tmp };
    }

    // The shims in .bin are shell scripts, so the system directories must be on the PATH too.
    const withBuf = `${toolBin}:${dirname(process.execPath)}:/usr/bin:/bin`;
    /** A PATH on which `buf` cannot be found. */
    const withoutBuf = dirname(process.execPath);

    before(async () => {
        assert.ok(existsSync(cliBinary), `the built CLI ${cliBinary} is missing: run the package build before the tests`);
        assert.ok(existsSync(join(toolBin, "buf")), `buf is missing in ${toolBin}: run pnpm install`);

        server = createServer({ services: [], port: 0, interceptors: [], protocols: [Healthcheck(), Reflection()], allowHTTP1: false });
        await server.start();
        port = server.address?.port as number;
        assert.ok(port, "the server must have an assigned port");

        http1Server = createServer({ services: [], port: 0, interceptors: [], protocols: [Healthcheck(), Reflection()] });
        await http1Server.start();
        http1Port = http1Server.address?.port as number;
        assert.ok(http1Port, "the HTTP/1.1 server must have an assigned port");

        // A port nobody listens on and nobody can take in the meantime. A port freed by stopping a
        // server is not that: the files of this package run in parallel, and an ephemeral bind of
        // another test can receive the very number just released, so the CLI would reach a live
        // server and print an "unimplemented" error instead of a refusal. Port 1 lies below the
        // ephemeral range and, being privileged, cannot be bound by an unprivileged test process.
        closedPort = UNBINDABLE_PORT;
        assert.equal(await probeLoopbackPort(closedPort), "ECONNREFUSED", `127.0.0.1:${closedPort} must refuse connections for the "nobody listens" cases; something on this host serves it`);

        mkdirSync(scratchRoot, { recursive: true });
        workdir = mkdtempSync(join(scratchRoot, "proto-sync-e2e-"));
    });

    after(async () => {
        await server?.stop();
        await http1Server?.stop();
        if (workdir) {
            rmSync(workdir, { recursive: true, force: true });
        }
    });

    describe("a full sync", () => {
        it("generates the types of every service the server lists into --out, from a bare host:port address", async () => {
            const { cwd, out, tmp } = sandbox();
            writeFileSync(join(cwd, "template.yaml"), PLUGIN_TEMPLATE("."));

            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${port}`, "--out", out, "--template", "template.yaml"], { cwd, tmpdir: tmp, path: withBuf });

            assert.equal(run.code, 0, run.output);
            // protoc-gen-es writes <proto path without .proto>_pb.ts; the server mounts
            // grpc.health.v1.Health, declared in grpc/health/v1/health.proto.
            const health = join(out, "grpc/health/v1/health_pb.ts");
            assert.ok(existsSync(health), `${health} was not generated:\n${run.output}`);
            assert.match(readFileSync(health, "utf8"), /HealthCheckRequest/);
        });

        it("uses the template named by --template and writes below --out, not the buf.gen.yaml of the working directory", async () => {
            const { cwd, out, tmp } = sandbox();
            writeFileSync(join(cwd, "buf.gen.yaml"), PLUGIN_TEMPLATE("from-working-directory"));
            writeFileSync(join(cwd, "chosen.yaml"), PLUGIN_TEMPLATE("from-flag"));

            const run = await runCli(["proto", "sync", "--from", `http://127.0.0.1:${port}`, "--out", out, "--template", "chosen.yaml"], { cwd, tmpdir: tmp, path: withBuf });

            assert.equal(run.code, 0, run.output);
            assert.ok(existsSync(join(out, "from-flag/grpc/health/v1/health_pb.ts")), "the template of the flag must decide where the plugin writes");
            assert.equal(existsSync(join(out, "from-working-directory")), false, "the template of the working directory must not be used when --template is given");
            // Without --output buf would write relative to the working directory, outside --out.
            assert.equal(existsSync(join(cwd, "from-flag")), false, "files must go below --out, not next to the working directory");
        });

        it("falls back to the buf.gen.yaml of the working directory when --template is not given", async () => {
            const { cwd, out, tmp } = sandbox();
            writeFileSync(join(cwd, "buf.gen.yaml"), PLUGIN_TEMPLATE("from-working-directory"));

            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${port}`, "--out", out], { cwd, tmpdir: tmp, path: withBuf });

            assert.equal(run.code, 0, run.output);
            assert.ok(existsSync(join(out, "from-working-directory/grpc/health/v1/health_pb.ts")));
        });

        it("leaves nothing in the temporary directory after a successful run", async () => {
            const { cwd, out, tmp } = sandbox();
            writeFileSync(join(cwd, "template.yaml"), PLUGIN_TEMPLATE("."));

            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${port}`, "--out", out, "--template", "template.yaml"], { cwd, tmpdir: tmp, path: withBuf });

            assert.equal(run.code, 0, run.output);
            assert.deepEqual(readdirSync(tmp), []);
        });

        it("exits non-zero with buf's own diagnostic when buf fails, and still leaves the temporary directory empty", async () => {
            const { cwd, out, tmp } = sandbox();
            writeFileSync(join(cwd, "broken.yaml"), ["version: v2", "plugins:", "  - local: protoc-gen-no-such-plugin", "    out: .", ""].join("\n"));

            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${port}`, "--out", out, "--template", "broken.yaml"], { cwd, tmpdir: tmp, path: withBuf });

            assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}`);
            // buf's stderr must reach the user: it is the only place that names the missing plugin.
            assert.match(run.output, /protoc-gen-no-such-plugin/);
            assert.deepEqual(readdirSync(tmp), []);
        });

        it("exits non-zero and names buf when buf is not installed, generating nothing", async () => {
            const { cwd, out, tmp } = sandbox();
            writeFileSync(join(cwd, "template.yaml"), PLUGIN_TEMPLATE("."));

            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${port}`, "--out", out, "--template", "template.yaml"], { cwd, tmpdir: tmp, path: withoutBuf });

            assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}`);
            assert.match(run.output, /buf was not found on the PATH/);
            assert.equal(existsSync(out), false);
            assert.deepEqual(readdirSync(tmp), []);
        });
    });

    describe("--dry-run", () => {
        it("lists the services, needs no buf, and generates and leaves nothing", async () => {
            const { cwd, out, tmp } = sandbox();

            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${port}`, "--out", out, "--dry-run"], { cwd, tmpdir: tmp, path: withoutBuf });

            assert.equal(run.code, 0, run.output);
            assert.match(run.output, /grpc\.health\.v1\.Health/);
            assert.equal(existsSync(out), false, "a dry run must not create the output directory");
            assert.deepEqual(readdirSync(tmp), [], "a dry run must not write a descriptor file");
        });
    });

    describe("the server address", () => {
        it("keeps an explicit http:// scheme as given", async () => {
            const { cwd, out, tmp } = sandbox();

            const run = await runCli(["proto", "sync", "--from", `http://127.0.0.1:${port}`, "--out", out, "--dry-run"], { cwd, tmpdir: tmp, path: withoutBuf });

            assert.equal(run.code, 0, run.output);
            assert.ok(run.output.includes(`Connected to http://127.0.0.1:${port}`), run.output);
            assert.ok(!run.output.includes("http://http://"), "the scheme must not be added twice");
        });

        it("does not downgrade https:// to http://: a TLS request to this plaintext server fails", async () => {
            const { cwd, out, tmp } = sandbox();

            const run = await runCli(["proto", "sync", "--from", `https://127.0.0.1:${port}`, "--out", out, "--dry-run", "--timeout", "3000"], { cwd, tmpdir: tmp, path: withoutBuf });

            assert.ok(run.code !== null && run.code !== 0, `a TLS handshake with a plaintext HTTP/2 server cannot succeed, got exit code ${run.code}:\n${run.output}`);
            assert.ok(run.output.includes(`https://127.0.0.1:${port}`), run.output);
        });

        it("refuses a scheme the command does not speak, naming it, although a server listens there", async () => {
            const { cwd, out, tmp } = sandbox();

            const run = await runCli(["proto", "sync", "--from", `ftp://127.0.0.1:${port}`, "--out", out, "--dry-run"], { cwd, tmpdir: tmp, path: withoutBuf });

            assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}`);
            assert.match(run.output, /"ftp"/);
            assert.ok(run.output.includes("host:port") && run.output.includes("https://"), `the accepted forms must be listed, got: ${run.output}`);
            assert.ok(!run.output.includes("Connecting to") && !run.output.includes("Connected to"), "the address must be refused before any connection attempt");
            assert.equal(existsSync(out), false);
        });
    });

    describe("failures reach the exit code", () => {
        for (const mode of [["--dry-run"], []]) {
            it(`exits non-zero when nobody listens at the address${mode.length > 0 ? " (dry run)" : " (full sync)"}`, async () => {
                const { cwd, out, tmp } = sandbox();
                const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${closedPort}`, "--out", out, ...mode], { cwd, tmpdir: tmp, path: withBuf });

                assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}`);
                assert.match(run.output, /ECONNREFUSED/);
                assert.equal(existsSync(out), false);
            });
        }

        for (const [missing, given] of [
            ["--from", ["--out", "o"]],
            ["--out", ["--from", "127.0.0.1:1"]],
        ] as const) {
            it(`refuses a call without ${missing} and says which argument is missing`, async () => {
                const { cwd, tmp } = sandbox();
                const run = await runCli(["proto", "sync", ...given], { cwd, tmpdir: tmp, path: withBuf });

                assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}`);
                assert.match(run.output, new RegExp(`Missing required argument: ${missing}`));
            });
        }
    });

    // The user reads one line that names what failed. A raw error object (stack frames, `rawMessage`,
    // `isWireError`) is a defect report about the CLI, not an answer to a mistyped address or a missing tool.
    describe("failures read as one line", () => {
        /** Asserts the run ended with exactly the line `Error: <message>` and no error dump. */
        function assertOneLine(run: CliRun, message: RegExp): void {
            assert.equal(run.killed, false, `the process hung:\n${run.output}`);
            assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}\n${run.output}`);
            assert.match(run.output, new RegExp(`^Error: ${message.source}`, "m"), run.output);
            assert.ok(!/\n\s+at /.test(run.output), `a stack trace must not be printed:\n${run.output}`);
            assert.ok(!/rawMessage|isWireError|ConnectError/.test(run.output), `an error object must not be printed:\n${run.output}`);
        }

        for (const mode of [["--dry-run"], []]) {
            it(`names the address and the reason when nobody listens${mode.length > 0 ? " (dry run)" : " (full sync)"}`, async () => {
                const { cwd, out, tmp } = sandbox();
                const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${closedPort}`, "--out", out, ...mode], { cwd, tmpdir: tmp, path: withBuf });

                assertOneLine(run, new RegExp(`Cannot connect to http://127\\.0\\.0\\.1:${closedPort}: ECONNREFUSED`));
            });
        }

        // createServer() without `allowHTTP1: false` is an HTTP/1.1-only server on plain TCP, and the
        // command speaks HTTP/2 to it: Node reports `ERR_HTTP2_ERROR`, Connect `[internal] Protocol error`.
        it("says that the server did not speak HTTP/2 and what to change when it serves HTTP/1.1 only", async () => {
            const { cwd, out, tmp } = sandbox();
            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${http1Port}`, "--out", out, "--dry-run"], { cwd, tmpdir: tmp, path: withoutBuf });

            assertOneLine(run, new RegExp(`HTTP/2 protocol error talking to http://127\\.0\\.0\\.1:${http1Port}`));
            assert.ok(run.output.includes("HTTP/1.1"), run.output);
            assert.ok(run.output.includes("allowHTTP1: false"), `the fix must be named:\n${run.output}`);
        });

        it("refuses an empty --from before connecting", async () => {
            const { cwd, out, tmp } = sandbox();
            const run = await runCli(["proto", "sync", "--from", "", "--out", out, "--dry-run"], { cwd, tmpdir: tmp, path: withoutBuf });

            assertOneLine(run, /--from must not be empty/);
            assert.ok(!run.output.includes("Connecting to"), `the address must be refused before any connection:\n${run.output}`);
        });

        it("names the value of a --from that is not a URL, before connecting", async () => {
            const { cwd, out, tmp } = sandbox();
            const run = await runCli(["proto", "sync", "--from", "local host:5305", "--out", out, "--dry-run"], { cwd, tmpdir: tmp, path: withoutBuf });

            assertOneLine(run, /--from "local host:5305" is not a valid server address/);
            assert.ok(!run.output.includes("Connecting to"), `the address must be refused before any connection:\n${run.output}`);
        });

        it("refuses a --template that is not a file before connecting, naming it", async () => {
            const { cwd, out, tmp } = sandbox();
            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${port}`, "--out", out, "--template", "nonexist.yaml"], { cwd, tmpdir: tmp, path: withBuf });

            assertOneLine(run, /--template "nonexist\.yaml" is not an existing file/);
            assert.ok(!run.output.includes("Connecting to"), `the template must be checked before any connection:\n${run.output}`);
            assert.equal(existsSync(out), false);
        });

        it("refuses a --template that is a directory", async () => {
            const { cwd, out, tmp } = sandbox();
            mkdirSync(join(cwd, "a-directory"));
            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${port}`, "--out", out, "--template", "a-directory"], { cwd, tmpdir: tmp, path: withBuf });

            assertOneLine(run, /--template "a-directory" is not an existing file/);
        });

        it("says that buf is not on the PATH instead of dumping the spawn error", async () => {
            const { cwd, out, tmp } = sandbox();
            writeFileSync(join(cwd, "template.yaml"), PLUGIN_TEMPLATE("."));
            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${port}`, "--out", out, "--template", "template.yaml"], { cwd, tmpdir: tmp, path: withoutBuf });

            assertOneLine(run, /buf was not found on the PATH/);
            assert.ok(run.output.includes("https://buf.build/docs/installation"), run.output);
            assert.equal(existsSync(out), false);
        });

        it("reports the exit code of a failing buf after buf's own diagnostic", async () => {
            const { cwd, out, tmp } = sandbox();
            writeFileSync(join(cwd, "broken.yaml"), ["version: v2", "plugins:", "  - local: protoc-gen-no-such-plugin", "    out: .", ""].join("\n"));
            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${port}`, "--out", out, "--template", "broken.yaml"], { cwd, tmpdir: tmp, path: withBuf });

            assertOneLine(run, /buf generate failed with exit code 1/);
            assert.match(run.output, /protoc-gen-no-such-plugin/);
        });
    });

    describe("--timeout bounds", () => {
        // The Connect client sends the limit as the grpc-timeout header in milliseconds, and the
        // gRPC HTTP/2 protocol allows the header value at most eight digits. 99999999 is therefore
        // the largest limit a server accepts; one more (nine digits) is refused here, before any
        // connection, instead of being sent and refused by the server as "invalid grpc timeout value".
        it("accepts the maximum 99999999 and completes against a live server", async () => {
            const { cwd, out, tmp } = sandbox();

            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${port}`, "--out", out, "--dry-run", "--timeout", "99999999"], { cwd, tmpdir: tmp, path: withoutBuf });

            assert.equal(run.code, 0, run.output);
            assert.match(run.output, /grpc\.health\.v1\.Health/);
        });

        it("ends promptly after the work is done instead of waiting for the per-request limit to expire", async () => {
            const { cwd, out, tmp } = sandbox();
            const started = Date.now();

            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${port}`, "--out", out, "--dry-run", "--timeout", "20000"], { cwd, tmpdir: tmp, path: withoutBuf });

            assert.equal(run.code, 0, run.output);
            assert.ok(Date.now() - started < 8000, `a finished dry run must not outlive the work by the whole limit, took ${Date.now() - started} ms`);
        });

        it("ends promptly with the default 10000 ms limit too", async () => {
            const { cwd, out, tmp } = sandbox();
            const started = Date.now();

            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${port}`, "--out", out, "--dry-run"], { cwd, tmpdir: tmp, path: withoutBuf });

            assert.equal(run.code, 0, run.output);
            assert.ok(Date.now() - started < 8000, `a finished dry run must not wait out the 10000 ms default limit, took ${Date.now() - started} ms`);
        });

        it("refuses 100000000 before connecting, although the server is up", async () => {
            const { cwd, out, tmp } = sandbox();

            const run = await runCli(["proto", "sync", "--from", `127.0.0.1:${port}`, "--out", out, "--dry-run", "--timeout", "100000000"], { cwd, tmpdir: tmp, path: withoutBuf });

            assert.ok(run.code !== null && run.code !== 0, `expected a non-zero exit code, got ${run.code}`);
            assert.match(run.output, /--timeout must be a positive integer/);
            assert.ok(run.output.includes("99999999"), `the message must quote the maximum 99999999:\n${run.output}`);
            assert.ok(!run.output.includes("Connected to"), "the limit must be refused before any connection");
        });
    });
});
