/**
 * `server.stop()` with a shutdown hook that fails.
 *
 * Hooks release resources they own (pools, brokers). One failing hook says
 * nothing about whether the others can still succeed, so `stop()` must run
 * every hook, wait for all of them, and only then emit `stop` and reject.
 * Process code commonly answers a rejected `stop()` with `process.exit(1)`,
 * which would otherwise kill the hooks that were still running.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createServer } from "../../src/Server.ts";

describe("server.stop() when a shutdown hook fails", () => {
    it("runs the dependent of the failed hook, waits for the independent slow hook, then emits stop and rejects", async () => {
        const server = createServer({ services: [], port: 0, host: "127.0.0.1" });
        const timeline: string[] = [];
        server.on("error", () => {});
        server.on("stop", () => timeline.push("stop event"));

        server.onShutdown("cache", async () => {
            timeline.push("cache hook");
            throw new Error("cache flush failed");
        });
        server.onShutdown("db", ["cache"], async () => {
            timeline.push("db hook");
        });
        server.onShutdown("queue", async () => {
            timeline.push("queue hook started");
            await new Promise<void>((resolve) => setTimeout(resolve, 200));
            timeline.push("queue hook finished");
        });
        await server.start();

        await assert.rejects(
            () => server.stop(),
            (err: unknown) => err instanceof Error && err.message === "cache flush failed",
        );
        timeline.push("stop() rejected");

        const position = (entry: string) => timeline.indexOf(entry);
        assert.ok(position("db hook") > position("cache hook"), `the dependent runs after the failed hook: ${timeline.join(" | ")}`);
        assert.ok(position("db hook") !== -1, "the dependent of the failed hook runs");
        assert.ok(position("queue hook finished") !== -1 && position("queue hook finished") < position("stop event"), `stop is emitted after the slow hook: ${timeline.join(" | ")}`);
        assert.ok(position("queue hook finished") < position("stop() rejected"), `stop() rejects after the slow hook: ${timeline.join(" | ")}`);
        assert.strictEqual(server.state, "stopped");
    });

    it("reports every failed hook through one AggregateError, also on the error event", async () => {
        const server = createServer({ services: [], port: 0, host: "127.0.0.1" });
        const reported: unknown[] = [];
        server.on("error", (err) => reported.push(err));
        server.onShutdown("a", async () => {
            throw new Error("a failed");
        });
        server.onShutdown("b", async () => {
            throw new Error("b failed");
        });
        await server.start();

        await assert.rejects(
            () => server.stop(),
            (err: unknown) => err instanceof AggregateError && err.errors.map((e: Error) => e.message).join("|") === "a failed|b failed",
        );
        assert.strictEqual(reported.length, 1, "the failure is reported through the error event once");
        assert.ok(reported[0] instanceof AggregateError);
    });
});
