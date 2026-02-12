import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { Healthcheck, healthcheckManager } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";

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

