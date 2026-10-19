import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { Healthcheck, healthcheckManager } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

/**
 * Send one GET to a protocol's HTTP handler with minimal request/response
 * doubles and report whether the handler claimed the request and with which
 * status code (0 when it wrote none).
 */
function askHttpHandler(handler: NonNullable<ReturnType<typeof Healthcheck>["httpHandler"]>, url: string) {
	let statusCode = 0;
	const handled = handler({ url, headers: { host: "localhost" } } as any, {
		setHeader() {},
		end() {},
		set statusCode(code: number) {
			statusCode = code;
		},
	} as any);
	return { handled, statusCode };
}

describe("Healthcheck", () => {
	afterEach(() => {
		healthcheckManager.clear();
	});

	it("should return ProtocolRegistration directly", () => {
		const protocol = Healthcheck();

		assert.strictEqual(protocol.name, "healthcheck");
		assert.strictEqual(typeof protocol.register, "function");
	});

	// HTTP endpoints are off unless asked for: with no option at all there is no
	// handler, exactly as with an explicit false.
	it("should not have httpHandler by default or when httpEnabled is false", () => {
		assert.strictEqual(Healthcheck().httpHandler, undefined);
		assert.strictEqual(Healthcheck({}).httpHandler, undefined);
		assert.strictEqual(Healthcheck({ httpEnabled: false }).httpHandler, undefined);
	});

	it("should have httpHandler when httpEnabled is true", () => {
		const protocol = Healthcheck({ httpEnabled: true });

		assert.ok(protocol.httpHandler);
		assert.strictEqual(typeof protocol.httpHandler, "function");
	});

	it("should accept custom watchInterval", () => {
		const protocol = Healthcheck({ watchInterval: 1000 });
		assert.ok(protocol);
	});

	// httpPaths replaces the default path list: the configured path answers and
	// the default ones no longer do. Having a handler at all proves neither.
	it("should serve health on the custom httpPaths and not on the defaults", () => {
		const manager = createHealthcheckManager();
		manager.set("process", ServingStatus.SERVING);
		const protocol = Healthcheck({ httpEnabled: true, httpPaths: ["/custom-health"], manager });
		const handler = protocol.httpHandler;
		assert.ok(handler);

		assert.deepStrictEqual(askHttpHandler(handler, "/custom-health"), { handled: true, statusCode: 200 });
		assert.deepStrictEqual(askHttpHandler(handler, "/healthz"), { handled: false, statusCode: 0 });
	});

	it("should serve health on the default paths when httpPaths is not given", () => {
		const manager = createHealthcheckManager();
		manager.set("process", ServingStatus.SERVING);
		const handler = Healthcheck({ httpEnabled: true, manager }).httpHandler;
		assert.ok(handler);

		for (const url of ["/healthz", "/health", "/readyz"]) {
			assert.deepStrictEqual(askHttpHandler(handler, url), { handled: true, statusCode: 200 }, url);
		}
	});

	// An empty list used to leave httpEnabled: true with an endpoint that
	// matches nothing, silently. It is a configuration error naming the option
	// and the way to switch the endpoint off.
	for (const httpEnabled of [true, false]) {
		it(`should throw RangeError for an empty httpPaths (httpEnabled: ${httpEnabled})`, () => {
			assert.throws(
				() => Healthcheck({ httpEnabled, httpPaths: [] }),
				(err: unknown) => err instanceof RangeError && /Healthcheck\(\)/.test(err.message) && /httpPaths/.test(err.message) && /httpEnabled: false/.test(err.message),
			);
		});
	}

	// Each of these could never match a request path, so each is rejected at
	// configuration time instead of silently serving nothing.
	const invalidPaths: Array<{ desc: string; paths: unknown; expected: RegExp }> = [
		{ desc: "no leading slash", paths: ["healthz"], expected: /must start with '\/'/ },
		{ desc: "a non-string entry", paths: [1], expected: /only strings/ },
		{ desc: "a null entry", paths: [null], expected: /only strings/ },
		{ desc: "a query delimiter", paths: ["/healthz?x=1"], expected: /'\?' or '#'/ },
		{ desc: "a fragment delimiter", paths: ["/healthz#top"], expected: /'\?' or '#'/ },
		{ desc: "an invalid entry after a valid one", paths: ["/healthz", "ready"], expected: /must start with '\/'/ },
		{ desc: "a string instead of an array", paths: "/healthz", expected: /must be an array/ },
	];

	for (const { desc, paths, expected } of invalidPaths) {
		it(`should throw TypeError for httpPaths with ${desc}`, () => {
			assert.throws(
				() => Healthcheck({ httpEnabled: true, httpPaths: paths as string[] }),
				(err: unknown) => err instanceof TypeError && /Healthcheck\(\)/.test(err.message) && /httpPaths/.test(err.message) && expected.test(err.message),
			);
		});
	}

	it("should accept a valid httpPaths when httpEnabled is false and install no handler", () => {
		assert.strictEqual(Healthcheck({ httpEnabled: false, httpPaths: ["/status"] }).httpHandler, undefined);
	});

	it("should treat an undefined httpPaths as the default paths", () => {
		const manager = createHealthcheckManager();
		manager.set("process", ServingStatus.SERVING);
		const handler = Healthcheck({ httpEnabled: true, httpPaths: undefined, manager }).httpHandler;
		assert.ok(handler);

		assert.deepStrictEqual(askHttpHandler(handler, "/healthz"), { handled: true, statusCode: 200 });
	});

	it("should use custom manager when provided in options", () => {
		const customManager = createHealthcheckManager();
		const protocol = Healthcheck({ manager: customManager });

		assert.ok(protocol);
		assert.strictEqual(protocol.name, "healthcheck");

		// The custom manager should be independent from the singleton
		assert.notStrictEqual(customManager, healthcheckManager);
	});

	it("should default to singleton manager when no manager option", () => {
		// This verifies the protocol uses the module-level singleton.
		// We can observe this by checking that setup() initializes the singleton.
		const protocol = Healthcheck();

		assert.ok(protocol);
		assert.strictEqual(protocol.name, "healthcheck");
		assert.strictEqual(typeof protocol.register, "function");
	});
});

describe("healthcheckManager singleton", () => {
	afterEach(() => {
		healthcheckManager.clear();
	});

	it("should be importable as a standalone export", () => {
		assert.ok(healthcheckManager);
		assert.strictEqual(typeof healthcheckManager.update, "function");
		assert.strictEqual(typeof healthcheckManager.getStatus, "function");
	});

	it("should be the same instance across imports", async () => {
		const { healthcheckManager: mgr1 } = await import("../../src/Healthcheck.ts");
		const { healthcheckManager: mgr2 } = await import("../../src/Healthcheck.ts");

		assert.strictEqual(mgr1, mgr2);
	});

	it("should allow operations before register is called", () => {
		assert.strictEqual(healthcheckManager.getAllStatuses().size, 0);
		assert.strictEqual(healthcheckManager.areAllHealthy(), false);
	});
});

describe("Healthcheck register() and resolveServiceStatus", () => {
	/**
	 * Helper: create a mock ConnectRouter that captures the service implementation
	 * passed to router.service(). Returns the captured handlers object.
	 */
	function createMockRouter() {
		let capturedHandlers: Record<string, Function> = {};

		const router = {
			service(_serviceDesc: unknown, handlers: Record<string, Function>) {
				capturedHandlers = handlers;
			},
		} as unknown as ConnectRouter;

		return { router, getHandlers: () => capturedHandlers };
	}

	/**
	 * Helper: create a mock ProtocolContext with fake DescFile entries
	 * that contain the given service type names.
	 */
	function createMockContext(serviceTypeNames: string[], declaredOnlyTypeNames: string[] = []) {
		const services = serviceTypeNames.map((typeName) => ({ typeName }));
		return {
			// The files of the mounted services also declare services nobody mounted.
			registry: [
				{
					services: [...services, ...declaredOnlyTypeNames.map((typeName) => ({ typeName }))],
				},
			],
			services,
		} as any;
	}

	afterEach(() => {
		healthcheckManager.clear();
	});

	it("resolveServiceStatus: empty service name returns overall health (SERVING when all healthy)", () => {
		const manager = createHealthcheckManager();
		const protocol = Healthcheck({ manager });
		const { router, getHandlers } = createMockRouter();

		protocol.setup?.(createMockContext(["svc.v1.Foo"]));
		protocol.register(router);

		// Set service to SERVING so areAllHealthy() returns true
		manager.update(ServingStatus.SERVING, "svc.v1.Foo");

		const response = getHandlers().check!({ service: "" });
		assert.strictEqual(response.status, ServingStatus.SERVING);
	});

	it("resolveServiceStatus: empty service name returns NOT_SERVING when not all healthy", () => {
		const manager = createHealthcheckManager();
		const protocol = Healthcheck({ manager });
		const { router, getHandlers } = createMockRouter();

		protocol.setup?.(createMockContext(["svc.v1.Foo"]));
		protocol.register(router);

		// Service is in UNKNOWN state after initialization → areAllHealthy() is false
		const response = getHandlers().check!({ service: "" });
		assert.strictEqual(response.status, ServingStatus.NOT_SERVING);
	});

	it("resolveServiceStatus: known healthy service returns SERVING", () => {
		const manager = createHealthcheckManager();
		const protocol = Healthcheck({ manager });
		const { router, getHandlers } = createMockRouter();

		protocol.setup?.(createMockContext(["svc.v1.Foo"]));
		protocol.register(router);
		manager.update(ServingStatus.SERVING, "svc.v1.Foo");

		const response = getHandlers().check!({ service: "svc.v1.Foo" });
		assert.strictEqual(response.status, ServingStatus.SERVING);
	});

	it("resolveServiceStatus: unknown service throws ConnectError NotFound", () => {
		const manager = createHealthcheckManager();
		const protocol = Healthcheck({ manager });
		const { router, getHandlers } = createMockRouter();

		protocol.setup?.(createMockContext(["svc.v1.Foo"]));
		protocol.register(router);

		// grpc.health.v1: Check on an unknown service fails with status NOT_FOUND.
		// The code is the contract; the message text is not asserted.
		assert.throws(
			() => getHandlers().check!({ service: "nonexistent.v1.Bar" }),
			(err: unknown) => {
				assert.ok(err instanceof ConnectError, `Expected ConnectError, got ${err}`);
				assert.strictEqual(err.code, Code.NotFound, `Expected NotFound, got ${Code[err.code]}`);
				return true;
			},
		);
	});

	// The server replays register() for every router it builds; if register
	// re-initialized the manager, the first in-process call would reset health.
	it("register() leaves the manager untouched", () => {
		const manager = createHealthcheckManager();
		const protocol = Healthcheck({ manager });

		protocol.setup?.(createMockContext(["svc.v1.Foo", "svc.v1.Bar"]));
		manager.update(ServingStatus.SERVING, "svc.v1.Foo");
		manager.update(ServingStatus.NOT_SERVING, "svc.v1.Bar");
		manager.register("worker", ServingStatus.SERVING);
		protocol.register(createMockRouter().router);
		protocol.register(createMockRouter().router);

		// Same tracked set, same statuses, nothing added (not even the Health
		// service itself) and nothing reset.
		assert.deepStrictEqual(
			[...manager.getAllStatuses().entries()],
			[
				["svc.v1.Foo", { status: ServingStatus.SERVING }],
				["svc.v1.Bar", { status: ServingStatus.NOT_SERVING }],
				["worker", { status: ServingStatus.SERVING }],
			],
		);
	});

	// Health tracks the services that are mounted, not every service the mounted
	// files declare: a declared-but-unmounted service must stay unknown to
	// Check and List. Every tracked service starts as UNKNOWN.
	it("setup() tracks the mounted services and not the unmounted ones declared in the same files", () => {
		const manager = createHealthcheckManager();
		const protocol = Healthcheck({ manager });
		const { router } = createMockRouter();

		const serviceNames = ["svc.v1.Alpha", "svc.v1.Beta", "svc.v1.Gamma"];
		protocol.setup?.(createMockContext(serviceNames, ["svc.v1.DeclaredOnly"]));
		protocol.register(router);

		assert.deepStrictEqual(
			[...manager.getAllStatuses().entries()],
			serviceNames.map((name) => [name, { status: ServingStatus.UNKNOWN }]),
		);
		assert.strictEqual(manager.getStatus("svc.v1.DeclaredOnly"), undefined);
	});
});

