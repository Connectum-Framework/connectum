import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Code, ConnectError, type ConnectRouter } from "@connectrpc/connect";
import { Healthcheck, healthcheckManager } from "../../src/Healthcheck.ts";
import { createHealthcheckManager, HealthcheckManager } from "../../src/HealthcheckManager.ts";
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
		// An explicit undefined is not allowed by the option type, but plain
		// JavaScript callers and spread option objects do pass it.
		const handler = Healthcheck({ httpEnabled: true, httpPaths: undefined as unknown as string[], manager }).httpHandler;
		assert.ok(handler);

		assert.deepStrictEqual(askHttpHandler(handler, "/healthz"), { handled: true, statusCode: 200 });
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

	// The manager passed in the options is the one the protocol reports from
	// and initializes; the module singleton is left alone.
	it("reports from the manager given in options and leaves the singleton untouched", () => {
		const singletonBefore = [...healthcheckManager.getAllStatuses().entries()];
		const customManager = createHealthcheckManager();
		const protocol = Healthcheck({ manager: customManager });
		const { router, getHandlers } = createMockRouter();

		protocol.setup?.(createMockContext(["svc.v1.Foo"]));
		protocol.register(router);
		customManager.update(ServingStatus.SERVING, "svc.v1.Foo");

		assert.strictEqual(getHandlers().check!({ service: "svc.v1.Foo" }).status, ServingStatus.SERVING);
		assert.deepStrictEqual([...healthcheckManager.getAllStatuses().entries()], singletonBefore);
	});

	// Without the manager option the module-level singleton is what the
	// application controls with healthcheckManager.update(): it is initialized
	// by setup and read by Check.
	it("uses the singleton healthcheckManager when no manager is given", () => {
		const protocol = Healthcheck();
		const { router, getHandlers } = createMockRouter();

		protocol.setup?.(createMockContext(["svc.v1.Foo"]));
		protocol.register(router);

		assert.deepStrictEqual(
			[...healthcheckManager.getAllStatuses().entries()],
			[["svc.v1.Foo", { status: ServingStatus.UNKNOWN }]],
		);
		healthcheckManager.update(ServingStatus.SERVING, "svc.v1.Foo");
		assert.strictEqual(getHandlers().check!({ service: "svc.v1.Foo" }).status, ServingStatus.SERVING);
		assert.strictEqual(getHandlers().check!({ service: "" }).status, ServingStatus.SERVING);
	});

	// grpc.health.v1: a tracked service that is not serving answers Check with
	// status NOT_SERVING; only an untracked name is NOT_FOUND.
	it("resolveServiceStatus: a tracked service reports its own NOT_SERVING and UNKNOWN as they are", () => {
		const manager = createHealthcheckManager();
		const protocol = Healthcheck({ manager });
		const { router, getHandlers } = createMockRouter();

		protocol.setup?.(createMockContext(["svc.v1.Foo", "svc.v1.Bar"]));
		protocol.register(router);
		manager.update(ServingStatus.NOT_SERVING, "svc.v1.Foo");

		assert.strictEqual(getHandlers().check!({ service: "svc.v1.Foo" }).status, ServingStatus.NOT_SERVING);
		assert.strictEqual(getHandlers().check!({ service: "svc.v1.Bar" }).status, ServingStatus.UNKNOWN);
	});
});

describe("Healthcheck Watch handler", () => {
	/**
	 * Install the protocol on a mock router and return its Watch handler, the
	 * isolated manager and the abort controller standing for the client call.
	 */
	function startWatch(options: { watchInterval?: number; manager?: HealthcheckManager } = {}) {
		const { manager = createHealthcheckManager(), ...rest } = options;
		const protocol = Healthcheck({ manager, ...rest });
		let handlers: Record<string, Function> = {};
		protocol.setup?.({ services: [{ typeName: "svc.v1.Foo" }], registry: [] } as any);
		protocol.register({
			service(_desc: unknown, impl: Record<string, Function>) {
				handlers = impl;
			},
		} as unknown as ConnectRouter);
		const controller = new AbortController();
		const stream = handlers.watch!({ service: "svc.v1.Foo" }, { signal: controller.signal }) as AsyncGenerator<{ status: ServingStatus }>;
		return { manager, controller, stream };
	}

	/**
	 * Resolve to the pending stream item, or to "silent" when it does not arrive
	 * in time. The same pending item can be awaited again: a second next() call
	 * on a generator would queue behind it and skip it.
	 */
	function within(pending: Promise<IteratorResult<{ status: ServingStatus }>>, ms: number) {
		return Promise.race([pending, delay(ms, "silent" as const)]);
	}

	// A change the manager announces reaches the client at once. It used to wait
	// for the next tick, up to the whole interval (500 ms by default).
	for (const [label, options] of [
		["a long watchInterval", { watchInterval: 60_000 }],
		["the default watchInterval", {}],
	] as const) {
		it(`reports an announced status change at once with ${label}`, async () => {
			const { manager, controller, stream } = startWatch(options);
			try {
				assert.strictEqual((await stream.next()).value?.status, ServingStatus.UNKNOWN);

				manager.update(ServingStatus.SERVING, "svc.v1.Foo");
				const second = await within(stream.next(), 250);

				assert.notStrictEqual(second, "silent", "the change must not wait for the interval");
				assert.strictEqual((second as IteratorResult<{ status: ServingStatus }>).value?.status, ServingStatus.SERVING);
			} finally {
				controller.abort();
			}
		});
	}

	// The interval still paces a re-check. A manager that changes state without
	// announcing it (here by overriding the read) is noticed on the next tick:
	// not before the interval, and within a few intervals after it.
	it("re-checks the status every watchInterval for a change the manager did not announce", async () => {
		class SilentManager extends HealthcheckManager {
			forced: ServingStatus | undefined;
			override getStatus(service: string) {
				return this.forced === undefined ? super.getStatus(service) : { status: this.forced };
			}
		}
		const manager = new SilentManager();
		const { controller, stream } = startWatch({ watchInterval: 100, manager });
		try {
			assert.strictEqual((await stream.next()).value?.status, ServingStatus.UNKNOWN);

			manager.forced = ServingStatus.NOT_SERVING;
			const pending = stream.next();
			const early = await within(pending, 40);
			assert.strictEqual(early, "silent", "nothing announced the change, so it waits for the tick");
			const late = await within(pending, 900);

			assert.notStrictEqual(late, "silent", "the periodic re-check must find the change");
			assert.strictEqual((late as IteratorResult<{ status: ServingStatus }>).value?.status, ServingStatus.NOT_SERVING);
		} finally {
			controller.abort();
		}
	});

	// "Terminates when the client disconnects": a call aborted while the
	// handler waits for the next poll ends the stream normally instead of
	// failing it with AbortError. The long interval keeps the handler inside
	// that wait when the abort arrives.
	it("ends the stream normally when the client call is aborted during the wait", async () => {
		const { controller, stream } = startWatch({ watchInterval: 60_000 });
		await stream.next();
		const waiting = stream.next();
		await delay(10);

		controller.abort();
		const end = await within(waiting, 2000);

		assert.notStrictEqual(end, "silent", "the aborted wait must end the stream promptly");
		assert.strictEqual((end as IteratorResult<{ status: ServingStatus }>).done, true);
	});
});

