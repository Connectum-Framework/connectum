/**
 * A start() that never settles must not make the process unkillable.
 *
 * The first termination signal during a hung start is honoured as a request to
 * stop once the start settles, which it never does here. The framework then
 * releases its signal handlers, so a repeated signal gets the default action and
 * ends the process, as a repeated signal does while a running server is stopping.
 * Real child process, real signals.
 */

import assert from "node:assert";
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER_SCRIPT = fileURLToPath(new URL("../fixtures/shutdown/hungStartServer.ts", import.meta.url));
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("signals while start() never settles", () => {
    const children: ChildProcess[] = [];

    afterEach(() => {
        for (const child of children.splice(0)) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
    });

    for (const signal of ["SIGTERM", "SIGINT"] as const) {
        it(`${signal}: the first signal is absorbed, a repeated one ends the process`, { timeout: 30_000 }, async () => {
            // Node 22.13 runs a TypeScript entry point only with the flag; Bun runs it natively.
            const execArgv = "bun" in process.versions ? process.execArgv : ["--experimental-strip-types", ...process.execArgv];
            const child = fork(SERVER_SCRIPT, [], { execArgv, stdio: ["ignore", "inherit", "inherit", "ipc"] });
            children.push(child);
            const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
            await new Promise<void>((resolve) => {
                child.on("message", (message: { type: string }) => message.type === "starting" && resolve());
            });
            await pause(200);

            child.kill(signal);
            await pause(500);
            assert.strictEqual(child.exitCode, null, `the first signal during the start must not end the process (exit ${child.exitCode}, signal ${child.signalCode})`);
            assert.strictEqual(child.signalCode, null);

            child.kill(signal);
            const [code, killedBy] = await Promise.race([exited, pause(10_000).then(() => assert.fail("a repeated signal must end a process whose start never settles"))]);
            assert.ok(killedBy === signal || code !== null, `ended by ${killedBy ?? code}`);
        });
    }
});
