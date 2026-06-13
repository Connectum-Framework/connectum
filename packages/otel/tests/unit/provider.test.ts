/**
 * Provider module tests
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { buildResourceAttributes, getProvider, initProvider, parseOtelResourceAttributesEnv, shutdownProvider } from "../../src/provider.ts";

const ATTR_SERVICE_NAME = "service.name";
const ATTR_SERVICE_VERSION = "service.version";
const ATTR_SERVICE_INSTANCE_ID = "service.instance.id";

// Disable real exporters for tests
process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

describe("provider", () => {
	afterEach(async () => {
		await shutdownProvider();
	});

	describe("getProvider", () => {
		it("should lazily create provider on first call", () => {
			const provider = getProvider();

			assert.ok(provider);
			assert.ok(provider.tracer);
			assert.ok(provider.meter);
			assert.ok(provider.logger);
		});

		it("should return same instance on subsequent calls", () => {
			const first = getProvider();
			const second = getProvider();

			assert.strictEqual(first, second);
		});
	});

	describe("initProvider", () => {
		it("should be idempotent when called twice", () => {
			initProvider();
			assert.doesNotThrow(() => initProvider());
		});
	});

	describe("shutdownProvider", () => {
		it("should allow re-initialization after shutdown", async () => {
			getProvider();
			await shutdownProvider();

			// Should not throw
			initProvider();
			const provider = getProvider();
			assert.ok(provider);
		});

		it("should be no-op when provider not initialized", async () => {
			// Should not throw
			await shutdownProvider();
		});
	});

	it("should accept instanceId and resourceAttributes without throwing", () => {
		assert.doesNotThrow(() => initProvider({ instanceId: "pod-7", resourceAttributes: { "device.id": "abc" } }));
	});
});

describe("parseOtelResourceAttributesEnv", () => {
	it("returns empty for undefined or empty input", () => {
		assert.deepStrictEqual(parseOtelResourceAttributesEnv(undefined), {});
		assert.deepStrictEqual(parseOtelResourceAttributesEnv(""), {});
	});

	it("parses comma-separated key=value pairs and trims whitespace", () => {
		assert.deepStrictEqual(parseOtelResourceAttributesEnv("a=1, b = two ,c=3"), { a: "1", b: "two", c: "3" });
	});

	it("keeps '=' inside values and skips malformed pairs", () => {
		assert.deepStrictEqual(parseOtelResourceAttributesEnv("url=http://x?a=b,=noKey,bad,k=v"), { url: "http://x?a=b", k: "v" });
	});
});

describe("buildResourceAttributes", () => {
	const base = { serviceName: "svc", serviceVersion: "1.2.3" };

	it("includes service name and version by default", () => {
		const attrs = buildResourceAttributes({ ...base, env: {} });
		assert.strictEqual(attrs[ATTR_SERVICE_NAME], "svc");
		assert.strictEqual(attrs[ATTR_SERVICE_VERSION], "1.2.3");
		assert.strictEqual(attrs[ATTR_SERVICE_INSTANCE_ID], undefined);
	});

	it("sets service.instance.id from explicit instanceId", () => {
		const attrs = buildResourceAttributes({ ...base, instanceId: "pod-7", env: {} });
		assert.strictEqual(attrs[ATTR_SERVICE_INSTANCE_ID], "pod-7");
	});

	it("sets service.instance.id from OTEL_SERVICE_INSTANCE_ID env", () => {
		const attrs = buildResourceAttributes({ ...base, env: { OTEL_SERVICE_INSTANCE_ID: "env-pod" } });
		assert.strictEqual(attrs[ATTR_SERVICE_INSTANCE_ID], "env-pod");
	});

	it("explicit instanceId takes precedence over env", () => {
		const attrs = buildResourceAttributes({ ...base, instanceId: "explicit", env: { OTEL_SERVICE_INSTANCE_ID: "env-pod" } });
		assert.strictEqual(attrs[ATTR_SERVICE_INSTANCE_ID], "explicit");
	});

	it("merges OTEL_RESOURCE_ATTRIBUTES env attributes", () => {
		const attrs = buildResourceAttributes({ ...base, env: { OTEL_RESOURCE_ATTRIBUTES: "device.id=d1,facility=f1" } });
		assert.strictEqual(attrs["device.id"], "d1");
		assert.strictEqual(attrs.facility, "f1");
	});

	it("explicit resourceAttributes take precedence over env attributes", () => {
		const attrs = buildResourceAttributes({
			...base,
			resourceAttributes: { "device.id": "explicit" },
			env: { OTEL_RESOURCE_ATTRIBUTES: "device.id=env,facility=f1" },
		});
		assert.strictEqual(attrs["device.id"], "explicit");
		assert.strictEqual(attrs.facility, "f1");
	});

	it("supports non-string attribute values", () => {
		const attrs = buildResourceAttributes({ ...base, resourceAttributes: { replica: 3, primary: true }, env: {} });
		assert.strictEqual(attrs.replica, 3);
		assert.strictEqual(attrs.primary, true);
	});
});
