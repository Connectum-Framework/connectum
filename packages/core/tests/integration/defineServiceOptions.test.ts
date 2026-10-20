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
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

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

    it("applies the per-service interceptor to its own service only", async () => {
        const seen: string[] = [];
        const counting: Interceptor = (next) => async (req) => {
            seen.push(req.service.typeName);
            return next(req);
        };
        const echo = defineService(
            EchoService,
            {
                echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
                rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
            },
            { interceptors: [counting] },
        );
        const other = defineService(StreamingService, {
            echo: (req) => create(ItemSchema, { value: req.value, sequence: req.sequence }),
            async *server() {},
            client: async () => create(CountSchema, { total: 0 }),
            async *bidi() {},
        });

        const server = createServer({ services: [echo, other] });
        await server.localClient(StreamingService).echo(create(ItemSchema, { value: "x" }));
        await server.localClient(EchoService).echo(create(EchoRequestSchema, { message: "a" }));

        assert.deepEqual(seen, [EchoService.typeName], "a service-scoped interceptor must not run for another service");
    });
});
