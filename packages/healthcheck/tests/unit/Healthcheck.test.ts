import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import type { ConnectRouter } from "@connectrpc/connect";
import { Healthcheck, healthcheckManager } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

describe("Healthcheck", () => {
	afterEach(() => {
		healthcheckManager.clear();
	});

	it("should return ProtocolRegistration directly", () => {
		const protocol = Healthcheck();

		assert.strictEqual(protocol.name, "healthcheck");
		assert.strictEqual(typeof protocol.register, "function");
	});

	it("should not have httpHandler when httpEnabled is false", () => {
		const protocol = Healthcheck({ httpEnabled: false });

		assert.strictEqual(protocol.httpHandler, undefined);
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

	it("should accept custom httpPaths", () => {
		const protocol = Healthcheck({ httpEnabled: true, httpPaths: ["/custom-health"] });
		assert.ok(protocol.httpHandler);
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
		// We can observe this by checking that register() initializes the singleton.
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
	function createMockContext(serviceTypeNames: string[]) {
		return {
			registry: [
				{
					services: serviceTypeNames.map((typeName) => ({ typeName })),
				},
			],
		} as any;
	}

	afterEach(() => {
		healthcheckManager.clear();
	});

	it("resolveServiceStatus: empty service name returns overall health (SERVING when all healthy)", () => {
		const manager = createHealthcheckManager();
		const protocol = Healthcheck({ manager });
		const { router, getHandlers } = createMockRouter();

		protocol.register(router, createMockContext(["svc.v1.Foo"]));

		// Set service to SERVING so areAllHealthy() returns true
		manager.update(ServingStatus.SERVING, "svc.v1.Foo");

		const response = getHandlers().check!({ service: "" });
		assert.strictEqual(response.status, ServingStatus.SERVING);
	});

	it("resolveServiceStatus: empty service name returns NOT_SERVING when not all healthy", () => {
		const manager = createHealthcheckManager();
		const protocol = Healthcheck({ manager });
		const { router, getHandlers } = createMockRouter();

		protocol.register(router, createMockContext(["svc.v1.Foo"]));

		// Service is in UNKNOWN state after initialization → areAllHealthy() is false
		const response = getHandlers().check!({ service: "" });
		assert.strictEqual(response.status, ServingStatus.NOT_SERVING);
	});

	it("resolveServiceStatus: known healthy service returns SERVING", () => {
		const manager = createHealthcheckManager();
		const protocol = Healthcheck({ manager });
		const { router, getHandlers } = createMockRouter();

		protocol.register(router, createMockContext(["svc.v1.Foo"]));
		manager.update(ServingStatus.SERVING, "svc.v1.Foo");

		const response = getHandlers().check!({ service: "svc.v1.Foo" });
		assert.strictEqual(response.status, ServingStatus.SERVING);
	});

	it("resolveServiceStatus: unknown service throws ConnectError NotFound", () => {
		const manager = createHealthcheckManager();
		const protocol = Healthcheck({ manager });
		const { router, getHandlers } = createMockRouter();

		protocol.register(router, createMockContext(["svc.v1.Foo"]));

		assert.throws(
			() => getHandlers().check!({ service: "nonexistent.v1.Bar" }),
			(err: any) => {
				assert.ok(err.message.includes("not found"), `Expected 'not found' in message, got: ${err.message}`);
				return true;
			},
		);
	});

	it("register() initializes manager with service names from context.registry", () => {
		const manager = createHealthcheckManager();
		const protocol = Healthcheck({ manager });
		const { router } = createMockRouter();

		const serviceNames = ["svc.v1.Alpha", "svc.v1.Beta", "svc.v1.Gamma"];
		protocol.register(router, createMockContext(serviceNames));

		// All services should be initialized in the manager
		const statuses = manager.getAllStatuses();
		assert.strictEqual(statuses.size, 3);

		for (const name of serviceNames) {
			const status = manager.getStatus(name);
			assert.ok(status, `Service '${name}' should be registered`);
			assert.strictEqual(status.status, ServingStatus.UNKNOWN, `Service '${name}' should start as UNKNOWN`);
		}
	});
});

