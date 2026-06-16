/**
 * defineService per-service options — restores the capability the legacy
 * `(router) => router.service(Desc, impl, { interceptors })` form had: a
 * service-scoped interceptor chain (and other `router.service` options),
 * forwarded through `defineService(descriptor, handlers, options)`.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { Interceptor } from "@connectrpc/connect";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

describe("defineService per-service options", () => {
    it("applies a per-service interceptor to every method of the service", async () => {
        let calls = 0;
        const counting: Interceptor = (next) => async (req) => {
            calls += 1;
            return next(req);
        };

        const echo = defineService(
            EchoService,
            {
                echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
                secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            },
            { interceptors: [counting] },
        );

        const server = createServer({ services: [echo] });
        const client = server.localClient(EchoService);

        await client.echo(create(EchoRequestSchema, { message: "a" }));
        await client.secureEcho(create(EchoRequestSchema, { message: "b" }));

        assert.equal(calls, 2, "the per-service interceptor must run on every method");
    });

    it("works without options (the third argument is optional)", async () => {
        const echo = defineService(EchoService, {
            echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
            secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
        });
        const res = await createServer({ services: [echo] }).localClient(EchoService).echo(create(EchoRequestSchema, { message: "x" }));
        assert.equal(res.message, "echo:x");
    });
});
