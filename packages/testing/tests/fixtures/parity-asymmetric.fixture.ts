/**
 * Runnable fixture, executed in a child `node --test` process by the driver
 * tests: a scenario whose outcome depends on the transport it runs over,
 * registered WITHOUT a custom `compare`. The driver must fail this test with
 * the default structural diff.
 */

import { create } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { transportParityTest } from "../../src/transportParityTest.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "./echo/v1/echo_pb.ts";

transportParityTest("asymmetric scenario", {
    services: [
        defineService(EchoService, {
            echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
            secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        }),
    ],
    scenario: async ({ transport, transportKind }) => {
        const res = await createClient(EchoService, transport).echo(create(EchoRequestSchema, { message: "hello" }));
        // Same server answer on both transports, but the reported payload
        // carries the transport kind, so the two runs deliberately differ.
        return { response: { message: res.message, via: transportKind } };
    },
});
