/**
 * Child-process server whose event bus never finishes starting.
 *
 * It stands in for a broker connect that hangs. The parent sends termination
 * signals and observes whether the process can still be ended.
 */

import { createServer } from "../../../src/Server.ts";

const server = createServer({
    services: [],
    port: 0,
    host: "127.0.0.1",
    eventBus: { start: () => new Promise<void>(() => {}), stop: async () => {} },
    shutdown: { autoShutdown: true, signals: ["SIGTERM", "SIGINT"] },
});

// start() never settles, so the result is deliberately not awaited.
void server.start().catch(() => {});
process.send?.({ type: "starting" });

// A hung broker connection keeps the event loop alive in a real process; a timer stands in for it.
setInterval(() => {}, 1000);
