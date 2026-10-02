/**
 * Retrying a failed initial route materialization.
 *
 * The server keeps the result of route materialization only once it succeeds,
 * so an attempt that throws (a protocol's `setup` or `register`, a service's
 * `register`) leaves nothing behind and the next attempt builds everything
 * again, calling every protocol's `setup` again. The retry must start from
 * empty state: if the services and files collected by the failed attempt
 * leaked into the retry, a protocol would see services registered after its
 * own position — Healthcheck would start tracking its own Health service as
 * UNKNOWN and overall health would never reach SERVING. Once a materialization
 * has succeeded, routers built later must not call `setup` at all.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import type { ConnectRouter } from "@connectrpc/connect";
import { defineService } from "../../src/defineService.ts";
import { createLocalTransport } from "../../src/localTransport.ts";
import { createServer } from "../../src/Server.ts";
import type { ProtocolContext, ProtocolRegistration } from "../../src/types.ts";
import { EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { CountSchema, ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

interface SetupView {
    services: string[];
    files: string[];
}

function viewOf(context: ProtocolContext): SetupView {
    return {
        services: context.services.map((service) => service.typeName),
        files: context.registry.map((file) => file.name),
    };
}

/**
 * Stands in for Healthcheck: it records the services it would track and
 * mounts a service of its own, the way Healthcheck mounts `grpc.health.v1.Health`.
 */
function trackingProtocol(): ProtocolRegistration & { setupCalls: number; views: SetupView[] } {
    const state = {
        name: "tracking",
        setupCalls: 0,
        views: [] as SetupView[],
        setup(context: ProtocolContext) {
            state.setupCalls++;
            state.views.push(viewOf(context));
        },
        register(router: ConnectRouter) {
            router.service(StreamingService, {
                echo: (req) => create(ItemSchema, { value: `tracking:${req.value}`, sequence: req.sequence }),
                async *server() {},
                client: async () => create(CountSchema, { total: 0 }),
                async *bidi() {},
            });
        },
    };
    return state;
}

/** A protocol listed after `trackingProtocol` whose `setup` throws on its first call only. */
function failingOnceProtocol(): ProtocolRegistration & { setupCalls: number; views: SetupView[] } {
    const state = {
        name: "failing-once",
        setupCalls: 0,
        views: [] as SetupView[],
        setup(context: ProtocolContext) {
            state.setupCalls++;
            state.views.push(viewOf(context));
            if (state.setupCalls === 1) {
                throw new Error("setup failed on the first attempt");
            }
        },
        register(_router: ConnectRouter) {},
    };
    return state;
}

const echo = defineService(EchoService, {
    echo: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
    rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
});

/** What each protocol must see on any first-time materialization of this server. */
const applicationOnly: SetupView = { services: [EchoService.typeName], files: [EchoService.file.name] };
const applicationAndTracking: SetupView = {
    services: [EchoService.typeName, StreamingService.typeName],
    files: [EchoService.file.name, StreamingService.file.name],
};

describe("retrying a failed initial route materialization", () => {
    it("starts over: setup runs again and sees nothing from the failed attempt", async () => {
        const tracking = trackingProtocol();
        const failingOnce = failingOnceProtocol();
        const server = createServer({ services: [echo], port: 0, allowHTTP1: false, protocols: [tracking, failingOnce] });

        assert.throws(() => server.localClient(EchoService), /setup failed on the first attempt/, "the first materialization must surface the setup error");
        assert.deepStrictEqual(tracking.views, [applicationOnly], "the failed attempt reached the tracking protocol with the application services only");

        const client = server.localClient(EchoService);
        assert.strictEqual(tracking.setupCalls, 2, "the retry calls setup again");
        assert.strictEqual(failingOnce.setupCalls, 2, "the retry calls setup again");
        assert.deepStrictEqual(tracking.views[1], applicationOnly, "the retry must not show the tracking protocol the service it mounted in the failed attempt");
        assert.deepStrictEqual(failingOnce.views[1], failingOnce.views[0], "the retry must give the later protocol the same view as the failed attempt did");
        assert.deepStrictEqual(failingOnce.views[1], applicationAndTracking);

        const reply = await client.echo({ message: "after-retry" });
        assert.strictEqual(reply.message, "after-retry", "the server must be usable after the retry");
    });

    it("does not call setup again for routers built after a successful materialization", async () => {
        const tracking = trackingProtocol();
        const server = createServer({ services: [echo], port: 0, allowHTTP1: false, protocols: [tracking] });

        await server.localClient(EchoService).echo({ message: "first" });
        assert.strictEqual(tracking.setupCalls, 1);

        // createLocalTransport builds a router of its own right away, so this
        // is a later router that registers every protocol again.
        const transport = createLocalTransport(server);
        assert.ok(transport);
        assert.strictEqual(tracking.setupCalls, 1, "a router built after a successful materialization must not call setup");

        // start() serves the handler built by the first materialization.
        await server.start();
        try {
            assert.strictEqual(tracking.setupCalls, 1, "start() must not call setup again");
            assert.deepStrictEqual(tracking.views, [applicationOnly]);
        } finally {
            await server.stop();
        }
    });
});
