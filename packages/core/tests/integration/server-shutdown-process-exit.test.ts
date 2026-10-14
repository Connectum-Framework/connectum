/**
 * The host process ends by itself after `stop()` even if a client holds its
 * connection open.
 *
 * The server runs in its own child process; the parent connects a client that
 * never closes (a raw `allowHalfOpen` socket) and asks the child to stop. With
 * the default `forceCloseOnTimeout` the child must exit with code 0 without
 * being killed or told to exit: the framework never calls `process.exit()`, so
 * a process that lingers means a connection the server left open.
 */

import assert from "node:assert";
import { type ChildProcess, fork } from "node:child_process";
import { once } from "node:events";
import type { Socket } from "node:net";
import { afterEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { HTTP2_FRAME_SETTINGS, HTTP2_PREFACE, stubbornClient } from "../helpers/rawClients.ts";

const SERVER_SCRIPT = fileURLToPath(new URL("../fixtures/shutdown/stubbornClientServer.ts", import.meta.url));
const TIMEOUT_MS = 400;
/** After the timeout only socket destruction and process teardown remain; 5 s absorbs a loaded host and a slow runtime start. */
const EXIT_SLACK_MS = 5000;

describe("process exit after stop() with a client that never closes", () => {
    const children: ChildProcess[] = [];
    const clients: Socket[] = [];

    afterEach(() => {
        for (const client of clients.splice(0)) client.destroy();
        for (const child of children.splice(0)) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
    });

    const cases = [
        { name: "HTTP/1.1 with an unfinished request", allowHTTP1: true, payload: "GET / HTTP/1.1\r\nHost: loc" },
        { name: "h2c with an established session", allowHTTP1: false, payload: HTTP2_PREFACE },
    ] as const;

    for (const { name, allowHTTP1, payload } of cases) {
        it(`${name}: the child process exits with code 0 within the timeout plus slack`, { timeout: 30_000 }, async () => {
            const child = fork(SERVER_SCRIPT, [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
            children.push(child);
            const exited = once(child, "exit") as Promise<[number | null, NodeJS.Signals | null]>;
            const reply = (type: string) =>
                new Promise<{ type: string; port?: number }>((resolve) => {
                    const listener = (message: { type: string; port?: number }) => {
                        if (message.type === type) {
                            child.off("message", listener);
                            resolve(message);
                        }
                    };
                    child.on("message", listener);
                });

            const ready = reply("ready");
            child.send({ type: "start", timeout: TIMEOUT_MS, allowHTTP1 });
            const { port } = await ready;
            // Wait until the server certainly counts the connection as in use:
            // an HTTP/1.1 request has begun (the child reports it) or the HTTP/2
            // session has sent its SETTINGS.
            const dataRead = reply("data");
            let sawSettings: () => void = () => {};
            const settings = new Promise<void>((resolve) => {
                sawSettings = resolve;
            });
            clients.push(
                await stubbornClient({
                    port: port ?? 0,
                    payload,
                    onHttp2Frame: (type) => {
                        if (type === HTTP2_FRAME_SETTINGS) sawSettings();
                    },
                }),
            );
            // Bun's node:http never reports connection reads (the fixture's hook never
            // fires) but does not close idle connections early either: nothing to wait for.
            await (allowHTTP1 ? ("bun" in process.versions ? undefined : dataRead) : settings);

            const stopped = reply("stopped");
            child.send({ type: "stop" });
            await stopped;

            let deadline: ReturnType<typeof setTimeout> | undefined;
            const timedOut = new Promise<"timeout">((resolve) => {
                deadline = setTimeout(() => resolve("timeout"), EXIT_SLACK_MS);
            });
            const outcome = await Promise.race([exited, timedOut]);
            clearTimeout(deadline);

            assert.notStrictEqual(outcome, "timeout", "the process is still alive: the server left a connection or handle open");
            assert.deepStrictEqual(outcome, [0, null]);
        });
    }
});
