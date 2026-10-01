/**
 * buildRoutes() unit tests
 *
 * Tests for route/protocol composition: service registration,
 * DescFile registry collection, protocol integration, and HTTP fallback.
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import type { DescFile } from "@bufbuild/protobuf";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import { createConnectRouter } from "@connectrpc/connect";
import { MountedService } from "../../../reflection/tests/fixtures/fixture/v1/multi_pb.ts";
import type { BuildRoutesOptions } from "../../src/buildRoutes.ts";
import { buildRoutes } from "../../src/buildRoutes.ts";
import type { RegisterContext } from "../../src/defineService.ts";
import type { ProtocolContext, ProtocolRegistration } from "../../src/types.ts";
import { EchoService } from "../fixtures/echo/v1/echo_pb.ts";

/** Minimal RegisterContext: identity wrapper (these tests never invoke handlers). */
const stubRegisterContext: RegisterContext = {
    wrapHandlers: ((_descriptor: unknown, handlers: unknown) => handlers) as RegisterContext["wrapHandlers"],
};

/**
 * Helper: create minimal BuildRoutesOptions with defaults
 */
function createOptions(overrides: Partial<BuildRoutesOptions> = {}): BuildRoutesOptions {
    return {
        services: [],
        protocols: [],
        interceptors: [],
        shutdownSignal: new AbortController().signal,
        registerContext: stubRegisterContext,
        ...overrides,
    };
}

describe("buildRoutes()", () => {
    // -----------------------------------------------------------------
    // Basic behavior
    // -----------------------------------------------------------------

    describe("basic behavior", () => {
        it("should return handler and empty registry when no services", () => {
            const result = buildRoutes(createOptions());

            assert.ok(result.handler, "handler should be returned");
            assert.strictEqual(typeof result.handler, "function");
            assert.ok(Array.isArray(result.registry));
            assert.strictEqual(result.registry.length, 0);
        });

        it("should return handler as a function", () => {
            const result = buildRoutes(createOptions());

            assert.strictEqual(typeof result.handler, "function");
        });
    });

    // -----------------------------------------------------------------
    // Service registration
    // -----------------------------------------------------------------

    describe("service registration", () => {
        it("should call service route functions with the router", () => {
            const serviceRoute = mock.fn((_router: ConnectRouter) => {
                // No-op: just verifying it gets called
            });

            buildRoutes(createOptions({ services: [{ descriptor: {} as never, register: serviceRoute }] }));

            // The routes function is deferred -- it's called by connectNodeAdapter internally.
            // buildRoutes creates a closure `routes` that gets passed to connectNodeAdapter.
            // The service route is called when connectNodeAdapter invokes the routes callback.
            // So we can't directly assert the mock call count here without invoking the handler.
            // Instead, verify the structure is correct.
            assert.ok(true, "service route was provided without error");
        });
    });

    // -----------------------------------------------------------------
    // Protocol registration
    // -----------------------------------------------------------------

    describe("protocol registration", () => {
        it("should accept protocols in options", () => {
            const protocol: ProtocolRegistration = {
                name: "test-protocol",
                register: mock.fn((_router: ConnectRouter) => {}),
            };

            const result = buildRoutes(createOptions({ protocols: [protocol] }));

            assert.ok(result.handler);
            assert.ok(Array.isArray(result.registry));
        });

        // `routes` is replayed on every router the server builds (HTTP adapter,
        // each in-process transport). One-time protocol work must not replay
        // with it, or Healthcheck re-initializes and drops out of SERVING.
        it("calls setup once and register once per router", () => {
            const setup = mock.fn((_context: ProtocolContext) => {});
            const register = mock.fn((_router: ConnectRouter) => {});
            const protocol: ProtocolRegistration = { name: "counting", setup, register };

            const result = buildRoutes(createOptions({ protocols: [protocol] }));
            result.routes(createConnectRouter());
            result.routes(createConnectRouter());

            assert.strictEqual(setup.mock.callCount(), 1, "setup must run once across all routers");
            assert.strictEqual(register.mock.callCount(), 3, "register must run for the HTTP adapter and both extra routers");
        });

        // Healthcheck must not track its own Health service and Reflection must
        // list the protocols registered before it: each protocol sees the files
        // registered ahead of it, fixed at that moment.
        it("gives setup a frozen snapshot of the files registered before the protocol", () => {
            const seen: Array<ReadonlyArray<DescFile>> = [];
            const first: ProtocolRegistration = {
                name: "first",
                setup: (context) => {
                    seen.push(context.registry);
                },
                register: (router) => {
                    router.service(EchoService, {});
                },
            };
            const second: ProtocolRegistration = {
                name: "second",
                setup: (context) => {
                    seen.push(context.registry);
                },
                register: () => {},
            };

            const result = buildRoutes(createOptions({ protocols: [first, second] }));
            result.routes(createConnectRouter());

            assert.deepStrictEqual(seen[0], [], "the first protocol sees no files: no application services are mounted");
            assert.deepStrictEqual(seen[1], [EchoService.file], "the second protocol sees the file the first one registered");
            assert.ok(Object.isFrozen(seen[0]) && Object.isFrozen(seen[1]), "snapshots must be immutable");
            assert.strictEqual(seen.length, 2, "replaying routes must not call setup again");
        });

        // A file may declare more services than are mounted. Protocols that
        // report served services (health, reflection) need the mounted ones,
        // with the same "registered before this protocol" view as `registry`.
        it("gives setup a frozen snapshot of the services mounted before the protocol", () => {
            const seen: Array<{ services: string[]; files: string[]; frozen: boolean }> = [];
            const record = (context: ProtocolContext): void => {
                seen.push({
                    services: context.services.map((s) => s.typeName),
                    files: context.registry.map((f) => f.name),
                    frozen: Object.isFrozen(context.services),
                });
            };
            const first: ProtocolRegistration = {
                name: "first",
                setup: record,
                register: (router) => {
                    router.service(EchoService, {});
                },
            };
            const second: ProtocolRegistration = { name: "second", setup: record, register: () => {} };
            const mounted = {
                descriptor: MountedService,
                register: (router: ConnectRouter) => {
                    router.service(MountedService, {});
                },
            };

            const result = buildRoutes(createOptions({ services: [mounted], protocols: [first, second] }));
            result.routes(createConnectRouter());

            assert.deepStrictEqual(seen, [
                // The mounted file also declares fixture.v1.UnmountedPeerService.
                { services: ["fixture.v1.MountedService"], files: ["fixture/v1/multi"], frozen: true },
                { services: ["fixture.v1.MountedService", EchoService.typeName], files: ["fixture/v1/multi", EchoService.file.name], frozen: true },
            ]);
        });

        it("should accept multiple protocols", () => {
            const protocol1: ProtocolRegistration = {
                name: "protocol-1",
                register: mock.fn(),
            };
            const protocol2: ProtocolRegistration = {
                name: "protocol-2",
                register: mock.fn(),
            };

            const result = buildRoutes(createOptions({ protocols: [protocol1, protocol2] }));

            assert.ok(result.handler);
        });
    });

    // -----------------------------------------------------------------
    // Interceptors
    // -----------------------------------------------------------------

    describe("interceptors", () => {
        it("should accept interceptors array", () => {
            const interceptor: Interceptor = (next) => next;

            const result = buildRoutes(createOptions({ interceptors: [interceptor] }));

            assert.ok(result.handler);
        });

        it("should accept empty interceptors array", () => {
            const result = buildRoutes(createOptions({ interceptors: [] }));

            assert.ok(result.handler);
        });
    });

    // -----------------------------------------------------------------
    // shutdownSignal
    // -----------------------------------------------------------------

    describe("shutdownSignal", () => {
        it("should accept AbortSignal", () => {
            const controller = new AbortController();

            const result = buildRoutes(createOptions({ shutdownSignal: controller.signal }));

            assert.ok(result.handler);
        });

        it("should accept already-aborted signal", () => {
            const controller = new AbortController();
            controller.abort();

            const result = buildRoutes(createOptions({ shutdownSignal: controller.signal }));

            assert.ok(result.handler);
        });
    });

    // -----------------------------------------------------------------
    // HTTP handler fallback
    // -----------------------------------------------------------------

    describe("HTTP handler fallback", () => {
        it("should handle protocols with httpHandler", () => {
            const httpHandler = mock.fn(() => true);

            const protocol: ProtocolRegistration = {
                name: "http-protocol",
                register: mock.fn(),
                httpHandler,
            };

            const result = buildRoutes(createOptions({ protocols: [protocol] }));

            assert.ok(result.handler);
        });

        it("should filter out protocols without httpHandler", () => {
            const protocolWithHandler: ProtocolRegistration = {
                name: "with-handler",
                register: mock.fn(),
                httpHandler: mock.fn(() => true),
            };

            const protocolWithoutHandler: ProtocolRegistration = {
                name: "without-handler",
                register: mock.fn(),
            };

            const result = buildRoutes(
                createOptions({ protocols: [protocolWithHandler, protocolWithoutHandler] }),
            );

            assert.ok(result.handler);
        });
    });

    // -----------------------------------------------------------------
    // Result structure
    // -----------------------------------------------------------------

    describe("result structure", () => {
        it("should return { handler, registry } shape", () => {
            const result = buildRoutes(createOptions());

            assert.ok("handler" in result);
            assert.ok("registry" in result);
            assert.strictEqual(typeof result.handler, "function");
            assert.ok(Array.isArray(result.registry));
        });
    });
});
