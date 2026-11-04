/**
 * A repeated termination signal while the server is stopping.
 *
 * The first SIGTERM/SIGINT starts the graceful shutdown. A second one is the
 * operator's way out of a shutdown that hangs (a hook that never settles), so it
 * ends the process at once, as for any Node.js process whose handler is gone. The
 * server says so in its log first, because a process that dies in the middle of
 * its hooks looks like a crash otherwise. Real child process, real signals.
 */

import assert from "node:assert";
import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer } from "../../src/Server.ts";

const SERVER_SCRIPT = fileURLToPath(new URL("../fixtures/shutdown/repeatedSignalServer.ts", import.meta.url));

interface Run {
    child: ChildProcess;
    output: () => string;
    exited: Promise<[number | null, NodeJS.Signals | null]>;
    hookStarted: Promise<void>;
}

describe("a repeated termination signal while stop() is running the shutdown hooks", () => {
    const children: ChildProcess[] = [];

    afterEach(() => {
        for (const child of children.splice(0)) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
    });

    async function launch(hookMs: number): Promise<Run> {
        // Node 22.13 runs a TypeScript entry point only with the flag; Bun runs it natively.
        const execArgv = "bun" in process.versions ? process.execArgv : ["--experimental-strip-types", ...process.execArgv];
        const child = spawn(process.execPath, [...execArgv, SERVER_SCRIPT, String(hookMs)], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
        children.push(child);
        let output = "";
        child.stdout?.on("data", (chunk) => (output += chunk));
        child.stderr?.on("data", (chunk) => (output += chunk));
        const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
        const message = (type: string) =>
            new Promise<void>((resolve, reject) => {
                child.on("message", (received: { type: string }) => received.type === type && resolve());
                // A child that dies before it reports must fail the test at once, not after the test timeout.
                child.once("exit", (code, killedBy) => reject(new Error(`the server process ended before "${type}" (exit ${code}, signal ${killedBy})\n${output}`)));
            });
        const hookStarted = message("hook-started");
        hookStarted.catch(() => {});
        await message("ready");
        return { child, output: () => output, exited, hookStarted };
    }

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
        it(`${signal}: the second signal ends the process in the middle of the hook, after a warning that says so`, { timeout: 30_000 }, async () => {
            const { child, output, exited, hookStarted } = await launch(10_000);

            child.kill(signal);
            await hookStarted;
            child.kill(signal);
            const [code, killedBy] = await exited;

            assert.strictEqual(killedBy, signal, `the process must end by the repeated signal (exit ${code})`);
            assert.match(output(), new RegExp(`Received ${signal}, initiating graceful shutdown`));
            assert.match(output(), new RegExp(`Received ${signal} again while the server is shutting down; the process is terminated now, without waiting for the remaining shutdown hooks`));
            assert.doesNotMatch(output(), /hook finished|stop event/, "the hook was cut short, so the shutdown did not complete");
        });
    }

    it("a single signal completes the shutdown, runs the hook to its end and warns about nothing", { timeout: 30_000 }, async () => {
        const { child, output, exited } = await launch(300);

        child.kill("SIGTERM");
        const [code, killedBy] = await exited;

        assert.strictEqual(killedBy, null);
        assert.strictEqual(code, 0);
        assert.match(output(), /hook finished/);
        assert.match(output(), /stop event/);
        assert.doesNotMatch(output(), /again while the server is shutting down/);
    });
});

describe("a repeated signal when the application has a listener of its own", () => {
    it("is not turned into process termination: the listener gets it, the log says why, and the handlers are gone afterwards", async () => {
        // SIGWINCH stands in for SIGTERM so that a mistaken kill cannot end the test process.
        const SIGNAL = "SIGWINCH";
        const warnings: string[] = [];
        const received: string[] = [];
        const own = () => received.push("own");
        process.on(SIGNAL, own);
        const before = process.listenerCount(SIGNAL);

        let release: () => void = () => {};
        const server = createServer({
            services: [],
            port: 0,
            host: "127.0.0.1",
            readMaxBytes: 0xffffffff,
            logger: { info() {}, warn: (message) => warnings.push(message), error() {} },
            shutdown: { autoShutdown: true, signals: [SIGNAL] },
        });
        server.onShutdown("slow", () => new Promise<void>((resolve) => (release = resolve)));
        await server.start();

        try {
            process.emit(SIGNAL);
            await new Promise<void>((resolve) => setTimeout(resolve, 50));
            assert.strictEqual(server.state, "stopping");
            process.emit(SIGNAL);

            assert.deepStrictEqual(received, ["own", "own"], "the application's listener receives both signals");
            assert.strictEqual(warnings.length, 1);
            assert.match(warnings[0] ?? "", /Received SIGWINCH again while the server is shutting down; other listeners handle it/);
            assert.strictEqual(server.state, "stopping", "the shutdown goes on");
        } finally {
            release();
            await server.stop();
            process.removeListener(SIGNAL, own);
        }
        assert.strictEqual(process.listenerCount(SIGNAL), before - 1, "no handler of the server is left after stop()");
    });
});
