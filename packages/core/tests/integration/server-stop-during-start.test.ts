/**
 * A termination request that arrives while `start()` is still in progress.
 *
 * Starting is the slowest phase when an event bus connects to a broker, and a
 * termination request is the one request an operator cannot repeat (Kubernetes
 * sends SIGTERM once and follows with SIGKILL). The request must be honoured:
 * `stop()` waits for the start to settle and then stops the server, and a signal
 * handler that exists from the first moment of the start does the same for
 * `autoShutdown`. SIGWINCH stands in for SIGTERM so that a missing handler
 * cannot kill the test process.
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { createServer } from "../../src/Server.ts";
import type { EventBusLike, Server } from "../../src/types.ts";

/** An event bus whose start() takes `startMs` (then succeeds, or fails with `failWith`). */
function slowBus(startMs: number, failWith?: Error) {
    const calls: string[] = [];
    const bus: EventBusLike = {
        start: async () => {
            calls.push("bus.start");
            await new Promise<void>((resolve) => setTimeout(resolve, startMs));
            if (failWith) {
                throw failWith;
            }
            calls.push("bus.started");
        },
        stop: async () => {
            calls.push("bus.stop");
        },
    };
    return { bus, calls };
}

/** Record the lifecycle events of `server` in the order they fire. */
function recordEvents(server: Server, into: string[]): void {
    server.on("start", () => into.push("start"));
    server.on("ready", () => into.push("ready"));
    server.on("stopping", () => into.push("stopping"));
    server.on("stop", () => into.push("stop"));
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("stop() and signals during start()", () => {
    const servers: Server[] = [];

    afterEach(async () => {
        for (const server of servers.splice(0)) {
            if (server.isRunning) {
                await server.stop();
            }
        }
    });

    function boot(options: Parameters<typeof createServer>[0]): Server {
        const server = createServer({ port: 0, host: "127.0.0.1", ...options });
        servers.push(server);
        return server;
    }

    it("stop() called while starting waits for the start, then stops the server", async () => {
        const { bus, calls } = slowBus(300);
        const server = boot({ services: [], eventBus: bus });
        const events: string[] = [];
        recordEvents(server, events);
        server.onShutdown("app", async () => {
            calls.push("hook");
        });

        const starting = server.start();
        await pause(50);
        assert.strictEqual(server.state, "starting");
        const stopping = server.stop();

        await starting;
        await stopping;

        assert.strictEqual(server.state, "stopped");
        assert.deepStrictEqual(events, ["start", "ready", "stopping", "stop"]);
        assert.deepStrictEqual(calls, ["bus.start", "bus.started", "hook", "bus.stop"], "the bus finished starting, then the hooks and the bus shutdown ran");
    });

    it("every stop() called while starting joins the same stop and settles with its outcome", async () => {
        const { bus } = slowBus(150);
        const server = boot({ services: [], eventBus: bus });
        let hookRuns = 0;
        server.onShutdown(async () => {
            hookRuns++;
            throw new Error("hook failed");
        });
        server.on("error", () => {});

        const starting = server.start();
        await pause(20);
        const first = server.stop();
        const second = server.stop();

        await starting;
        await assert.rejects(() => first, { message: "hook failed" });
        await assert.rejects(() => second, { message: "hook failed" });
        assert.strictEqual(hookRuns, 1, "the hook runs once");
        await server.stop();
        assert.strictEqual(hookRuns, 1, "a stop() after the server stopped does nothing");
    });

    it("stop() called while starting resolves, and start() rejects, when the start fails", async () => {
        const { bus } = slowBus(100, new Error("broker unreachable"));
        const server = boot({ services: [], eventBus: bus });
        server.on("error", () => {});

        const starting = server.start();
        const startOutcome = assert.rejects(() => starting, { message: "broker unreachable" });
        await pause(20);
        const stopping = server.stop();

        await startOutcome;
        await stopping;
        assert.strictEqual(server.state, "stopped");
    });

    it("stop() on a server that was never started still rejects", async () => {
        const server = boot({ services: [] });
        await assert.rejects(() => server.stop(), /Cannot stop server: current state is "created"/);
        assert.strictEqual(server.state, "created");
    });

    it("a signal during start() stops the server once the start has finished, instead of being dropped", async () => {
        const { bus, calls } = slowBus(300);
        const server = boot({ services: [], eventBus: bus, shutdown: { autoShutdown: true, signals: ["SIGWINCH"] } });
        const events: string[] = [];
        recordEvents(server, events);
        const stopped = new Promise<void>((resolve) => server.once("stop", () => resolve()));

        const starting = server.start();
        await pause(50);
        assert.strictEqual(server.state, "starting");
        assert.strictEqual(process.listenerCount("SIGWINCH") > 0, true, "the handler exists while the server is still starting");
        process.emit("SIGWINCH");

        await starting;
        await stopped;

        assert.strictEqual(server.state, "stopped");
        assert.deepStrictEqual(events, ["start", "ready", "stopping", "stop"]);
        assert.ok(calls.includes("bus.stop"), "the event bus was shut down");
    });

    it("leaves no signal handler behind when the start fails", async () => {
        const before = process.listenerCount("SIGWINCH");
        const { bus } = slowBus(30, new Error("broker unreachable"));
        const server = boot({ services: [], eventBus: bus, shutdown: { autoShutdown: true, signals: ["SIGWINCH"] } });
        server.on("error", () => {});

        await assert.rejects(() => server.start(), { message: "broker unreachable" });

        assert.strictEqual(process.listenerCount("SIGWINCH"), before);
    });

    it("keeps the signal handlers of a running server until it stops", async () => {
        const before = process.listenerCount("SIGWINCH");
        const server = boot({ services: [], shutdown: { autoShutdown: true, signals: ["SIGWINCH"] } });

        await server.start();
        assert.strictEqual(process.listenerCount("SIGWINCH"), before + 1);

        await server.stop();
        assert.strictEqual(process.listenerCount("SIGWINCH"), before);
    });
});
