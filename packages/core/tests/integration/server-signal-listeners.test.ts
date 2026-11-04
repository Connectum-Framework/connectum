/**
 * Process signal listeners of servers with `autoShutdown`.
 *
 * Node.js warns about a possible EventEmitter leak when more than ten listeners
 * are added for one event. A process (or a test suite) that hosts many servers
 * with `autoShutdown` must not trigger that warning, so the servers share one
 * process listener per signal; each server still reacts to the signal, and the
 * listener is gone when the last one stops. SIGWINCH stands in for SIGTERM so
 * that a stray signal cannot end the test process.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createServer } from "../../src/Server.ts";
import type { Server } from "../../src/types.ts";

const SIGNAL = "SIGWINCH";

function autoServer(extra: { signals?: NodeJS.Signals[] } = {}): Server {
    return createServer({ services: [], port: 0, host: "127.0.0.1", shutdown: { autoShutdown: true, signals: extra.signals ?? [SIGNAL] } });
}

/** Warnings the process emits while `run` executes (they are delivered asynchronously). */
async function captureWarnings(run: () => Promise<void>): Promise<string[]> {
    const warnings: string[] = [];
    const onWarning = (warning: Error) => warnings.push(`${warning.name}: ${warning.message}`);
    process.on("warning", onWarning);
    try {
        await run();
        await new Promise<void>((resolve) => setTimeout(resolve, 50));
    } finally {
        process.removeListener("warning", onWarning);
    }
    return warnings;
}

describe("autoShutdown signal listeners", () => {
    it("twelve running servers add one process listener and no MaxListenersExceededWarning", async () => {
        const before = process.listenerCount(SIGNAL);
        const servers: Server[] = [];
        let during = -1;

        const warnings = await captureWarnings(async () => {
            for (let i = 0; i < 12; i++) {
                const server = autoServer();
                await server.start();
                servers.push(server);
            }
            during = process.listenerCount(SIGNAL);
        });
        for (const server of servers) {
            await server.stop();
        }

        assert.strictEqual(during, before + 1, "one shared listener, not one per server");
        assert.deepStrictEqual(
            warnings.filter((w) => w.includes("MaxListenersExceededWarning")),
            [],
        );
        assert.strictEqual(process.listenerCount(SIGNAL), before, "the shared listener is removed with the last server");
    });

    it("a signal reaches every server that opted in, and only those", async () => {
        const first = autoServer();
        const second = autoServer();
        const bystander = createServer({ services: [], port: 0, host: "127.0.0.1" });
        await first.start();
        await second.start();
        await bystander.start();

        process.emit(SIGNAL);
        await new Promise<void>((resolve) => setTimeout(resolve, 100));

        assert.strictEqual(first.state, "stopped");
        assert.strictEqual(second.state, "stopped");
        assert.strictEqual(bystander.state, "running", "a server without autoShutdown ignores the signal");
        await bystander.stop();
    });

    it("stopping one server leaves the others subscribed", async () => {
        const before = process.listenerCount(SIGNAL);
        const stays = autoServer();
        const leaves = autoServer();
        await stays.start();
        await leaves.start();

        await leaves.stop();
        assert.strictEqual(process.listenerCount(SIGNAL), before + 1, "the listener stays while a server still needs it");

        process.emit(SIGNAL);
        await new Promise<void>((resolve) => setTimeout(resolve, 100));
        assert.strictEqual(stays.state, "stopped", "the remaining server still reacts to the signal");
        assert.strictEqual(process.listenerCount(SIGNAL), before);
    });

    it("a server subscribed to two signals ends both subscriptions, and a repeated signal name is not leaked", async () => {
        const before = { first: process.listenerCount(SIGNAL), second: process.listenerCount("SIGUSR2") };
        const server = autoServer({ signals: [SIGNAL, "SIGUSR2", SIGNAL] });
        await server.start();
        assert.strictEqual(process.listenerCount(SIGNAL), before.first + 1);
        assert.strictEqual(process.listenerCount("SIGUSR2"), before.second + 1);

        await server.stop();

        assert.strictEqual(process.listenerCount(SIGNAL), before.first);
        assert.strictEqual(process.listenerCount("SIGUSR2"), before.second);
    });
});
