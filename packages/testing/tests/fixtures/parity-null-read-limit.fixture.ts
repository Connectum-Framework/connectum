/**
 * Runnable fixture, executed in a child `node --test` process by the driver
 * tests: a scenario that passes `readMaxBytes: null`, which `createServer()`
 * rejects. The driver must not turn it into the default limit; the registered
 * test has to fail with the server's own error.
 */

import { create } from "@bufbuild/protobuf";
import { defineService } from "@connectum/core";
import { transportParityTest } from "../../src/transportParityTest.ts";
import { EchoResponseSchema, EchoService } from "./echo/v1/echo_pb.ts";

transportParityTest("null read limit", {
    services: [
        defineService(EchoService, {
            echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        }),
    ],
    readMaxBytes: null as unknown as number,
    scenario: async () => ({ response: { reached: true } }),
});
