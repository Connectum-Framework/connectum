/**
 * Child-process server with a shutdown hook that takes a while.
 *
 * The parent sends termination signals while the hook runs and observes how the
 * process ends and what it logs. The hook length in milliseconds is the first
 * command-line argument.
 */

import { createServer } from "../../../src/Server.ts";

const hookMs = Number(process.argv[2] ?? 1500);

const server = createServer({
    services: [],
    port: 0,
    host: "127.0.0.1",
    shutdown: { autoShutdown: true, signals: ["SIGTERM", "SIGINT"] },
});

server.onShutdown("flush", async () => {
    process.send?.({ type: "hook-started" });
    await new Promise<void>((resolve) => setTimeout(resolve, hookMs));
    console.log("hook finished");
});
server.on("stop", () => console.log("stop event"));

await server.start();
process.send?.({ type: "ready" });
