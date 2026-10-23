/**
 * The host process ends by itself after `stop()` of a TLS server even if a
 * client holds its connection open and its request unfinished.
 *
 * Same method as the plaintext process-exit test, for the transport the
 * deployed services use. The server runs in its own child process with a
 * throwaway self-signed certificate; the parent connects a client that never
 * closes (a raw `allowHalfOpen` TLS socket) and asks the child to stop. With
 * the default `forceCloseOnTimeout` the child must exit with code 0 without
 * being killed or told to exit: the framework never calls `process.exit()`, so
 * a process that lingers means a connection the server left open. On the TLS
 * path the connection has two layers (the raw TCP socket and the decrypted
 * TLS socket plus the HTTP/2 session), and only the shutdown-timeout path that
 * destroys every layer lets the process end.
 */

import assert from "node:assert";
import { type ChildProcess, execFileSync, fork } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { HTTP2_FRAME_SETTINGS, HTTP2_PREFACE, stubbornClient, stubbornTlsClient } from "../helpers/rawClients.ts";

const SERVER_SCRIPT = fileURLToPath(new URL("../fixtures/shutdown/stubbornClientServer.ts", import.meta.url));
const TIMEOUT_MS = 400;
/** After the timeout only socket destruction and process teardown remain; 5 s absorbs a loaded host and a slow runtime start. */
const EXIT_SLACK_MS = 5000;

/** An HTTP/2 HEADERS frame (POST, https, `/`; END_HEADERS set, END_STREAM not) on stream 1: a request whose body never ends. */
const HTTP2_OPEN_POST_REQUEST = Buffer.from([0, 0, 3, 0x1, 0x4, 0, 0, 0, 1, 0x83, 0x87, 0x84]);

describe("process exit after stop() of a TLS server with a client that never closes", () => {
    let tlsDir: string;
    let tls: { keyPath: string; certPath: string };
    let ca: Buffer;
    const children: ChildProcess[] = [];
    const clients: Socket[] = [];

    before(() => {
        // A throwaway self-signed pair per run: no key material is committed.
        tlsDir = mkdtempSync(join(tmpdir(), "connectum-shutdown-tls-"));
        tls = { keyPath: join(tlsDir, "server.key"), certPath: join(tlsDir, "server.crt") };
        execFileSync(
            "openssl",
            ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", "/CN=localhost", "-keyout", tls.keyPath, "-out", tls.certPath],
            { stdio: "ignore" },
        );
        ca = readFileSync(tls.certPath);
    });

    after(() => {
        rmSync(tlsDir, { recursive: true, force: true });
    });

    afterEach(() => {
        for (const client of clients.splice(0)) client.destroy();
        for (const child of children.splice(0)) {
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
    });

    interface Scenario {
        name: string;
        allowHTTP1: boolean;
        /** Connect the stubborn client; `ready` must settle once the server certainly counts the connection as in use. */
        connect(port: number, ready: () => void): Promise<Socket>;
        /** The child message, or `"settings"` for the HTTP/2 SETTINGS frame, that proves the server is serving the connection. */
        readyOn: "data" | "accepted" | "settings";
    }

    const scenarios: Scenario[] = [
        {
            name: "an HTTP/2 stream whose request body never ends",
            allowHTTP1: false,
            readyOn: "settings",
            connect: (port, ready) =>
                stubbornTlsClient({
                    port,
                    ca,
                    alpn: "h2",
                    payload: Buffer.concat([HTTP2_PREFACE, HTTP2_OPEN_POST_REQUEST]),
                    onHttp2Frame: (type) => {
                        if (type === HTTP2_FRAME_SETTINGS) ready();
                    },
                }),
        },
        {
            name: "an HTTP/1.1 request cut off in its headers",
            allowHTTP1: true,
            readyOn: "data",
            connect: (port) => stubbornTlsClient({ port, ca, alpn: "http/1.1", payload: "GET / HTTP/1.1\r\nHost: loc" }),
        },
        {
            name: "a connection stuck in the middle of the TLS handshake",
            allowHTTP1: false,
            readyOn: "accepted",
            // The first byte of a TLS handshake record: the server waits for the rest of the ClientHello forever.
            connect: (port) => stubbornClient({ port, payload: Buffer.from([0x16]) }),
        },
    ];

    for (const scenario of scenarios) {
        it(`${scenario.name}: the child process exits with code 0 within the timeout plus slack`, { timeout: 30_000 }, async () => {
            // Node 22.13 runs a TypeScript entry point only with the flag; Bun runs it natively.
            const execArgv = "bun" in process.versions ? process.execArgv : ["--experimental-strip-types", ...process.execArgv];
            const child = fork(SERVER_SCRIPT, [], { execArgv, stdio: ["ignore", "inherit", "inherit", "ipc"] });
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
            child.send({ type: "start", timeout: TIMEOUT_MS, allowHTTP1: scenario.allowHTTP1, tls });
            const { port } = await ready;

            // A connection with no request under way is idle and closed by the graceful phase, which
            // would hide the case under test: stop only once the server certainly serves this one.
            const serving = scenario.readyOn === "settings" ? undefined : reply(scenario.readyOn);
            let sawSettings: () => void = () => {};
            const settings = new Promise<void>((resolve) => {
                sawSettings = resolve;
            });
            clients.push(await scenario.connect(port ?? 0, sawSettings));
            await (serving ?? settings);

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
