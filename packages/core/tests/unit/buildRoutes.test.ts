/**
 * buildRoutes() unit tests
 *
 * Route/protocol composition: service registration and the `enabledServices`
 * filter, DescFile registry collection, protocol setup and registration, and
 * the HTTP handler that is built around them (interceptors, shutdown signal,
 * protocol HTTP handlers, the 404 fallback).
 */

import assert from "node:assert";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, it, mock } from "node:test";
import { create, type DescFile } from "@bufbuild/protobuf";
import type { ConnectRouter, Interceptor } from "@connectrpc/connect";
import { createClient, createConnectRouter } from "@connectrpc/connect";
import { createConnectTransport } from "@connectrpc/connect-node";
import { MountedService, UnmountedPeerService } from "../../../reflection/tests/fixtures/fixture/v1/multi_pb.ts";
import type { BuildRoutesOptions } from "../../src/buildRoutes.ts";
import { buildRoutes } from "../../src/buildRoutes.ts";
import type { RegisterContext, ServiceDefinition } from "../../src/defineService.ts";
import { defineService } from "../../src/defineService.ts";
import type { NodeRequest, NodeResponse, ProtocolContext, ProtocolRegistration } from "../../src/types.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";

/** Minimal RegisterContext: identity wrapper, so handlers receive Connect's own HandlerContext. */
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

/** A service that mounts `descriptor` with no handlers (enough to appear in the registry). */
function mountOnly(descriptor: ServiceDefinition["descriptor"]): ServiceDefinition & { register: ReturnType<typeof mock.fn> } {
    const register = mock.fn((router: ConnectRouter) => {
        router.service(descriptor, {});
    });
    return { descriptor, register: register as never } as ServiceDefinition & { register: ReturnType<typeof mock.fn> };
}

describe("buildRoutes()", () => {
    // -----------------------------------------------------------------
    // Basic behavior
    // -----------------------------------------------------------------

    describe("basic behavior", () => {
        it("should mount nothing when there are no services and no protocols", () => {
            const result = buildRoutes(createOptions());

            assert.strictEqual(typeof result.handler, "function");
            assert.deepStrictEqual(result.registry, []);
            assert.deepStrictEqual([...result.registeredServiceTypeNames], []);
            assert.deepStrictEqual(result.userServices, []);
        });
    });

    // -----------------------------------------------------------------
    // Service registration
    // -----------------------------------------------------------------

    describe("service registration", () => {
        it("should register each service on the router together with the register context, in order", () => {
            const order: string[] = [];
            const received: unknown[] = [];
            const first: ServiceDefinition = {
                descriptor: EchoService,
                register: (router, context) => {
                    order.push("first");
                    received.push(router, context);
                },
            };
            const second: ServiceDefinition = {
                descriptor: MountedService,
                register: () => {
                    order.push("second");
                },
            };

            const result = buildRoutes(createOptions({ services: [first, second] }));
            // connectNodeAdapter has already materialized one router; a further one gets the same registrations.
            const router = createConnectRouter();
            result.routes(router);

            assert.deepStrictEqual(order, ["first", "second", "first", "second"]);
            assert.strictEqual(received[1], stubRegisterContext, "the register context is handed to the service as given");
            assert.strictEqual(received[2], router);
            assert.strictEqual(received[3], stubRegisterContext);
        });

        it("should list the files and typeNames of mounted services once, however many routers are built", () => {
            const result = buildRoutes(createOptions({ services: [mountOnly(EchoService), mountOnly(MountedService)] }));
            result.routes(createConnectRouter());
            result.routes(createConnectRouter());

            assert.deepStrictEqual(result.registry, [EchoService.file, MountedService.file]);
            assert.deepStrictEqual([...result.registeredServiceTypeNames].sort(), [EchoService.typeName, MountedService.typeName].sort());
            assert.deepStrictEqual(
                result.userServices.map((s) => s.typeName),
                [EchoService.typeName, MountedService.typeName],
            );
        });

        // Two services declared in one .proto file share one DescFile.
        it("should list a file once when two mounted services come from the same file", () => {
            const result = buildRoutes(createOptions({ services: [mountOnly(MountedService), mountOnly(UnmountedPeerService)] }));

            assert.deepStrictEqual(result.registry, [MountedService.file]);
            assert.deepStrictEqual(
                result.userServices.map((s) => s.typeName),
                [MountedService.typeName, UnmountedPeerService.typeName],
            );
        });

        // Only the services the application mounted are "user services"; whatever a protocol
        // mounts is registered, but is not the application's.
        it("should keep protocol-mounted services out of the user services", () => {
            const protocol: ProtocolRegistration = {
                name: "mounting",
                register: (router) => {
                    router.service(UnmountedPeerService, {});
                },
            };

            const result = buildRoutes(createOptions({ services: [mountOnly(EchoService)], protocols: [protocol] }));

            assert.deepStrictEqual(
                result.userServices.map((s) => s.typeName),
                [EchoService.typeName],
            );
            assert.deepStrictEqual([...result.registeredServiceTypeNames].sort(), [EchoService.typeName, UnmountedPeerService.typeName].sort());
        });

        // Service catalog guide: a service outside `enabledServices` is remote and is never
        // registered locally, so its register closure does not run.
        it("should mount only the services named in enabledServices", () => {
            const echo = mountOnly(EchoService);
            const mounted = mountOnly(MountedService);

            const result = buildRoutes(createOptions({ services: [echo, mounted], enabledServices: [MountedService.typeName] }));

            assert.strictEqual(echo.register.mock.callCount(), 0, "a service that is not enabled must not be registered");
            assert.strictEqual(mounted.register.mock.callCount(), 1);
            assert.deepStrictEqual([...result.registeredServiceTypeNames], [MountedService.typeName]);
            assert.deepStrictEqual(result.registry, [MountedService.file]);
        });

        it("should mount nothing when enabledServices is empty, and every service when it is not given", () => {
            const none = buildRoutes(createOptions({ services: [mountOnly(EchoService)], enabledServices: [] }));
            const all = buildRoutes(createOptions({ services: [mountOnly(EchoService), mountOnly(MountedService)] }));

            assert.deepStrictEqual([...none.registeredServiceTypeNames], []);
            assert.deepStrictEqual([...all.registeredServiceTypeNames].sort(), [EchoService.typeName, MountedService.typeName].sort());
        });
    });

    // -----------------------------------------------------------------
    // Protocol registration
    // -----------------------------------------------------------------

    describe("protocol registration", () => {
        it("should register the protocols in order after the application services", () => {
            const order: string[] = [];
            const service: ServiceDefinition = {
                descriptor: EchoService,
                register: () => {
                    order.push("service");
                },
            };
            const protocol = (name: string): ProtocolRegistration => ({
                name,
                setup: () => {
                    order.push(`${name}:setup`);
                },
                register: () => {
                    order.push(`${name}:register`);
                },
            });

            buildRoutes(createOptions({ services: [service], protocols: [protocol("a"), protocol("b")] }));

            assert.deepStrictEqual(order, ["service", "a:setup", "a:register", "b:setup", "b:register"]);
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

        it("should register a protocol that has no setup", () => {
            const register = mock.fn((_router: ConnectRouter) => {});

            buildRoutes(createOptions({ protocols: [{ name: "register-only", register }] }));

            assert.strictEqual(register.mock.callCount(), 1);
        });
    });

    // -----------------------------------------------------------------
    // The HTTP handler
    // -----------------------------------------------------------------

    describe("HTTP handler", () => {
        const servers: HttpServer[] = [];

        afterEach(async () => {
            for (const server of servers.splice(0)) {
                server.closeAllConnections();
                await new Promise<void>((resolve) => server.close(() => resolve()));
            }
        });

        /** Serve the handler of `options` over plaintext HTTP/1.1 and return its base URL. */
        async function serve(options: Partial<BuildRoutesOptions>): Promise<string> {
            const { handler } = buildRoutes(createOptions(options));
            const server = createHttpServer((req, res) => handler(req, res));
            servers.push(server);
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        }

        const echoService = (handler: (message: string, signal: AbortSignal) => Promise<string> | string = (m) => m): ServiceDefinition =>
            defineService(EchoService, {
                echo: async (req, ctx) => create(EchoResponseSchema, { message: await handler(req.message, ctx.signal), timestamp: 0n }),
                secureEcho: () => create(EchoResponseSchema, {}),
                rateLimitedEcho: () => create(EchoResponseSchema, {}),
            });

        const client = (baseUrl: string) => createClient(EchoService, createConnectTransport({ baseUrl, httpVersion: "1.1" }));

        it("should serve a registered RPC", async () => {
            const baseUrl = await serve({ services: [echoService((m) => `echo:${m}`)] });

            const response = await client(baseUrl).echo(create(EchoRequestSchema, { message: "hi" }));

            assert.strictEqual(response.message, "echo:hi");
        });

        it("should run the interceptors of the options, outermost first", async () => {
            const seen: string[] = [];
            const tag =
                (name: string): Interceptor =>
                (next) =>
                async (req) => {
                    seen.push(`${name}:${req.method.name}`);
                    return next(req);
                };
            const baseUrl = await serve({ services: [echoService()], interceptors: [tag("outer"), tag("inner")] });

            await client(baseUrl).echo(create(EchoRequestSchema, { message: "x" }));

            assert.deepStrictEqual(seen, ["outer:Echo", "inner:Echo"]);
        });

        it("should abort the signal of an in-flight call when the shutdown signal aborts", async () => {
            const shutdown = new AbortController();
            let started!: () => void;
            const handlerStarted = new Promise<void>((resolve) => {
                started = resolve;
            });
            let abortedInHandler = false;
            const baseUrl = await serve({
                shutdownSignal: shutdown.signal,
                services: [
                    echoService(async (_message, signal) => {
                        started();
                        await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
                        abortedInHandler = signal.aborted;
                        return "late";
                    }),
                ],
            });

            const call = client(baseUrl).echo(create(EchoRequestSchema, { message: "slow" }));
            call.catch(() => {});
            await handlerStarted;
            shutdown.abort();
            await call.catch(() => {});

            assert.strictEqual(abortedInHandler, true, "the handler's signal must follow the shutdown signal");
        });

        it("should hand a request that is not an RPC to the protocol HTTP handlers in order, stopping at the first that claims it", async () => {
            const asked: string[] = [];
            const handlerThat =
                (name: string, claims: (url: string) => boolean): NonNullable<ProtocolRegistration["httpHandler"]> =>
                (req: NodeRequest, res: NodeResponse) => {
                    asked.push(`${name}:${req.url}`);
                    if (!claims(req.url ?? "")) return false;
                    res.statusCode = 200;
                    res.end(`from ${name}`);
                    return true;
                };
            const baseUrl = await serve({
                protocols: [
                    { name: "no-http", register: () => {} },
                    { name: "one", register: () => {}, httpHandler: handlerThat("one", (url) => url === "/one") },
                    { name: "two", register: () => {}, httpHandler: handlerThat("two", (url) => url === "/one" || url === "/two") },
                ],
            });

            const one = await fetch(`${baseUrl}/one`);
            const two = await fetch(`${baseUrl}/two`);

            assert.strictEqual(await one.text(), "from one");
            assert.strictEqual(await two.text(), "from two");
            assert.deepStrictEqual(asked, ["one:/one", "one:/two", "two:/two"], "the second handler is not asked once the first has claimed the request");
        });

        it("should answer 404 Not Found to a request that no protocol HTTP handler claims", async () => {
            const baseUrl = await serve({ protocols: [{ name: "declines", register: () => {}, httpHandler: () => false }] });

            const response = await fetch(`${baseUrl}/nowhere`);

            assert.strictEqual(response.status, 404);
            assert.strictEqual(await response.text(), "Not Found");
        });
    });
});
