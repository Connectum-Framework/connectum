/**
 * Integration tests for createTestServer and withTestServer.
 *
 * These tests start real gRPC servers to verify lifecycle management: the
 * assigned port, that the returned transport really reaches the server, and
 * that a closed server stops accepting connections.
 */

import assert from "node:assert";
import { connect } from "node:net";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient, type Interceptor } from "@connectrpc/connect";
import { defineService, type ProtocolRegistration } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { createDefaultInterceptors } from "@connectum/interceptors";
import { Reflection } from "@connectum/reflection";
import { createTestServer, withTestServer } from "../../src/test-server.ts";
import type { TestServer } from "../../src/types.ts";
import { EchoRequestSchema, EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

const echoRoutes = defineService(EchoService, {
	echo: (req) => create(EchoResponseSchema, { message: `echo:${req.message}`, timestamp: 0n }),
	secureEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
	rateLimitedEcho: (req) => create(EchoResponseSchema, { message: req.message, timestamp: 0n }),
});

/** Resolves true when a TCP connection to the port is accepted, false when it is refused. */
function acceptsConnections(port: number): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = connect({ port, host: "localhost" });
		socket.once("connect", () => {
			socket.destroy();
			resolve(true);
		});
		socket.once("error", () => {
			socket.destroy();
			resolve(false);
		});
	});
}

async function callEcho(server: TestServer): Promise<string> {
	const res = await createClient(EchoService, server.transport).echo(create(EchoRequestSchema, { message: "ping" }));
	return res.message;
}

describe("createTestServer", () => {
	it("should start on a random port and serve calls through the returned transport", async () => {
		const server = await createTestServer({ services: [echoRoutes] });
		try {
			assert.ok(server.port > 0, `Expected port > 0, got ${server.port}`);
			assert.strictEqual(new URL(server.baseUrl).port, String(server.port), "baseUrl must point at the reported port");
			assert.strictEqual(await acceptsConnections(server.port), true, "the reported port must accept connections");
			assert.strictEqual(await callEcho(server), "echo:ping", "the transport must reach the handler of the started server");
		} finally {
			await server.close();
		}
	});

	it("should stop accepting connections once close() has resolved", async () => {
		const server = await createTestServer({ services: [echoRoutes] });
		assert.strictEqual(await acceptsConnections(server.port), true, "the server must be listening before close()");
		await server.close();

		assert.strictEqual(await acceptsConnections(server.port), false, "the port must refuse connections after close()");
		await assert.rejects(callEcho(server), (err: unknown) => ConnectError.from(err).code === Code.Unavailable);
	});

	it("should support multiple servers running in parallel", async () => {
		const [server1, server2] = await Promise.all([
			createTestServer({ services: [echoRoutes] }),
			createTestServer({ services: [echoRoutes] }),
		]);

		try {
			assert.ok(server1.port > 0, `Server 1 port should be > 0, got ${server1.port}`);
			assert.ok(server2.port > 0, `Server 2 port should be > 0, got ${server2.port}`);
			assert.notStrictEqual(
				server1.port,
				server2.port,
				`Servers should have different ports: ${server1.port} vs ${server2.port}`,
			);
			assert.strictEqual(await callEcho(server1), "echo:ping");
			assert.strictEqual(await callEcho(server2), "echo:ping");
		} finally {
			await Promise.all([server1.close(), server2.close()]);
		}
	});
});

describe("createTestServer options", () => {
	it("applies the given interceptors to every call", async () => {
		const reject: Interceptor = () => () => {
			throw new ConnectError("blocked by interceptor", Code.PermissionDenied);
		};
		const server = await createTestServer({ services: [echoRoutes], interceptors: [reject] });
		try {
			await assert.rejects(callEcho(server), (err: unknown) => {
				const connectErr = ConnectError.from(err);
				assert.strictEqual(connectErr.code, Code.PermissionDenied);
				assert.strictEqual(connectErr.rawMessage, "blocked by interceptor");
				return true;
			});
		} finally {
			await server.close();
		}
	});

	it("mounts the given protocols next to the services", async () => {
		const extra: ProtocolRegistration = {
			name: "extra",
			register(router) {
				router.service(StreamingService, {
					echo: (req) => create(ItemSchema, { value: `protocol:${req.value}`, sequence: req.sequence }),
					async *server() {},
					client: async () => ({ total: 0 }),
					async *bidi() {},
				});
			},
		};
		const server = await createTestServer({ services: [echoRoutes], protocols: [extra] });
		try {
			const item = await createClient(StreamingService, server.transport).echo(create(ItemSchema, { value: "x", sequence: 4 }));
			assert.strictEqual(item.value, "protocol:x");
			assert.strictEqual(item.sequence, 4);
			assert.strictEqual(await callEcho(server), "echo:ping", "the services stay reachable");
		} finally {
			await server.close();
		}
	});

	it("listens on the requested port, and reports it in port and baseUrl", async () => {
		// Learn a free port from a throwaway server, then ask for exactly that port.
		const probe = await createTestServer({ services: [echoRoutes] });
		const requested = probe.port;
		await probe.close();

		const server = await createTestServer({ services: [echoRoutes], port: requested });
		try {
			assert.strictEqual(server.port, requested);
			assert.strictEqual(new URL(server.baseUrl).port, String(requested));
			assert.strictEqual(await callEcho(server), "echo:ping");
		} finally {
			await server.close();
		}
	});

});

// A value that is not what the type says must fail up front, naming the option and the
// position of the element, and must not leave a listening server behind.
describe("createTestServer option validation", () => {
	const rejections: { name: string; options: unknown; message: RegExp }[] = [
		{ name: "options that are not an object", options: undefined, message: /createTestServer: options must be an object .* got a undefined\./ },
		{ name: "options that are an array", options: [], message: /options must be an object .* got an array\./ },
		{ name: "missing services", options: {}, message: /createTestServer: services must be an array of service definitions, got nothing\./ },
		{ name: "services that is not an array", options: { services: echoRoutes }, message: /services must be an array of service definitions, got a object\./ },
		{ name: "a string among the services", options: { services: ["not-a-service"] }, message: /services\[0\] must be a service definition returned by defineService\(\) or defineLazyService\(\), got the string "not-a-service"\./ },
		{ name: "a number among the services", options: { services: [echoRoutes, 42] }, message: /services\[1\] must be a service definition .* got a number\./ },
		{ name: "null among the services", options: { services: [null] }, message: /services\[0\] must be a service definition .* got null\./ },
		{ name: "an object that is not a service definition", options: { services: [{ descriptor: EchoService }] }, message: /services\[0\] must be a service definition/ },
		{ name: "interceptors that is not an array", options: { services: [echoRoutes], interceptors: () => undefined }, message: /interceptors must be an array of interceptor functions, got a function\./ },
		{ name: "a non-function among the interceptors", options: { services: [echoRoutes], interceptors: [(() => undefined) as unknown, "x"] }, message: /interceptors\[1\] must be an interceptor function, got the string "x"\./ },
		{ name: "protocols that is not an array", options: { services: [echoRoutes], protocols: "x" }, message: /protocols must be an array of protocol registrations, got the string "x"\./ },
		{ name: "a protocol without register()", options: { services: [echoRoutes], protocols: [{ name: "half" }] }, message: /protocols\[0\] must be a protocol registration with a name and a register\(\) function/ },
		{ name: "a protocol without a name", options: { services: [echoRoutes], protocols: [{ register() {} }] }, message: /protocols\[0\] must be a protocol registration/ },
	];
	for (const { name, options, message } of rejections) {
		it(`rejects ${name}, naming the option`, async () => {
			await assert.rejects(
				createTestServer(options as never),
				(err: unknown) => err instanceof TypeError && message.test(err.message),
			);
		});
	}

	it("rejects the same values through withTestServer, without running the test function", async () => {
		let ran = false;
		await assert.rejects(
			withTestServer({ services: ["not-a-service"] } as never, async () => {
				ran = true;
			}),
			(err: unknown) => err instanceof TypeError && /services\[0\]/.test(err.message),
		);
		assert.strictEqual(ran, false);
	});

	it("is a compile-time error to pass a value that is not a service, an interceptor or a protocol", () => {
		// The assertions below are the type-level contract: each line must NOT compile.
		// Nothing runs: createTestServer is not called.
		const compileOnly = () => {
			// @ts-expect-error a string is not a service definition
			void createTestServer({ services: ["not-a-service"] });
			// @ts-expect-error a number is not a service definition
			void createTestServer({ services: [42] });
			// @ts-expect-error null is not a service definition
			void createTestServer({ services: [null] });
			// @ts-expect-error a string is not an interceptor
			void createTestServer({ services: [echoRoutes], interceptors: ["x"] });
			// @ts-expect-error a string is not a protocol registration
			void createTestServer({ services: [echoRoutes], protocols: ["x"] });
		};
		assert.strictEqual(typeof compileOnly, "function");
	});

	it("accepts what the shipped factories return, as the documentation passes them", async () => {
		// Type-level contract: the return types of the real factories fit the typed lists.
		const server = await createTestServer({
			services: [echoRoutes],
			interceptors: createDefaultInterceptors(),
			protocols: [Healthcheck(), Reflection()],
		});
		try {
			assert.strictEqual(await callEcho(server), "echo:ping");
		} finally {
			await server.close();
		}
	});

	it("accepts readonly arrays of the documented element types", async () => {
		const services = [echoRoutes] as const;
		const interceptors: readonly Interceptor[] = [(next) => next];
		const protocols: readonly ProtocolRegistration[] = [];
		const server = await createTestServer({ services, interceptors, protocols });
		try {
			assert.strictEqual(await callEcho(server), "echo:ping");
		} finally {
			await server.close();
		}
	});
});

describe("withTestServer", () => {
	it("should provide a serving server and close it after testFn completes", async () => {
		let captured: TestServer | undefined;

		await withTestServer({ services: [echoRoutes] }, async (server) => {
			captured = server;
			assert.strictEqual(await acceptsConnections(server.port), true, "the server must be listening inside testFn");
			assert.strictEqual(await callEcho(server), "echo:ping");
		});

		assert.ok(captured, "Test function should have run");
		assert.strictEqual(await acceptsConnections(captured.port), false, "the server must be closed once withTestServer returns");
	});

	it("should close server and re-throw when testFn throws", async () => {
		const testError = new Error("intentional test failure");
		let captured: TestServer | undefined;

		await assert.rejects(
			() =>
				withTestServer({ services: [echoRoutes] }, async (server) => {
					captured = server;
					throw testError;
				}),
			(err: Error) => {
				assert.strictEqual(err, testError, "Should re-throw the original error");
				return true;
			},
		);

		assert.ok(captured, "Test function should have run");
		assert.strictEqual(await acceptsConnections(captured.port), false, "the server must be closed even though testFn threw");
	});

	it("should return the value from testFn", async () => {
		const result = await withTestServer({ services: [echoRoutes] }, async (server) => {
			return { port: server.port, ok: true };
		});

		assert.ok(result.ok, "Expected result.ok to be true");
		assert.ok(result.port > 0, `Expected result.port > 0, got ${result.port}`);
	});
});
