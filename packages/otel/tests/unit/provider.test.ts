/**
 * Provider module tests
 */

import assert from "node:assert";
import { afterEach, describe, it } from "node:test";
import { trace } from "@opentelemetry/api";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { buildResourceAttributes, getProvider, initProvider, parseOtelResourceAttributesEnv, resolveServiceName, shutdownProvider } from "../../src/provider.ts";

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
		it("keeps the first provider when called again, even with different options", () => {
			initProvider();
			const first = getProvider();

			initProvider({ serviceName: "other-service", instanceId: "other-pod" });

			assert.strictEqual(getProvider(), first);
			assert.strictEqual(getProvider().tracer, first.tracer);
			assert.strictEqual(getProvider().meter, first.meter);
		});
	});

	describe("shutdownProvider", () => {
		it("creates a new provider after shutdown instead of returning the stopped one", async () => {
			const stopped = getProvider();
			await shutdownProvider();

			initProvider();
			const fresh = getProvider();

			assert.notStrictEqual(fresh, stopped);
			assert.strictEqual(getProvider(), fresh);
		});

		it("does nothing when no provider was created: another party's global registration stays", async () => {
			const foreignTracer = new NodeTracerProvider();
			trace.setGlobalTracerProvider(foreignTracer);
			try {
				await assert.doesNotReject(shutdownProvider());

				assert.strictEqual(trace.getTracer("probe").startSpan("s").isRecording(), true, "the registered tracer provider is still in place");
			} finally {
				trace.disable();
			}
		});
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

	// The observability backends guide lists service.version and service.namespace among the
	// attributes OTEL_RESOURCE_ATTRIBUTES can carry, so the operator's value replaces the
	// default version (npm_package_version) rather than being dropped.
	it("lets OTEL_RESOURCE_ATTRIBUTES set service.version and service.namespace", () => {
		const attrs = buildResourceAttributes({ ...base, env: { OTEL_RESOURCE_ATTRIBUTES: "service.version=9.9.9,service.namespace=shop" } });
		assert.strictEqual(attrs[ATTR_SERVICE_VERSION], "9.9.9");
		assert.strictEqual(attrs["service.namespace"], "shop");
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

	it("keeps the resolved service name when OTEL_RESOURCE_ATTRIBUTES also names the service", () => {
		const attrs = buildResourceAttributes({ ...base, env: { OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs,facility=f1" } });
		assert.strictEqual(attrs[ATTR_SERVICE_NAME], "svc");
		assert.strictEqual(attrs.facility, "f1");
	});
});

// The OpenTelemetry SDK environment-variable specification: OTEL_SERVICE_NAME
// takes priority over `service.name` in OTEL_RESOURCE_ATTRIBUTES. Connectum adds
// the explicit option above both and the package name / "unknown-service" below.
describe("resolveServiceName", () => {
	it("prefers OTEL_SERVICE_NAME over service.name in OTEL_RESOURCE_ATTRIBUTES", () => {
		const name = resolveServiceName({ env: { OTEL_SERVICE_NAME: "from-env", OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs" } });
		assert.strictEqual(name, "from-env");
	});

	it("falls back to service.name in OTEL_RESOURCE_ATTRIBUTES when OTEL_SERVICE_NAME is unset or empty", () => {
		assert.strictEqual(resolveServiceName({ env: { OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs" } }), "from-attrs");
		assert.strictEqual(resolveServiceName({ env: { OTEL_SERVICE_NAME: "", OTEL_RESOURCE_ATTRIBUTES: "a=b, service.name = from-attrs" } }), "from-attrs");
	});

	it("lets the explicit option beat both environment variables", () => {
		const name = resolveServiceName({ explicit: "from-code", env: { OTEL_SERVICE_NAME: "from-env", OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs" } });
		assert.strictEqual(name, "from-code");
	});

	it("uses the package name, then 'unknown-service', when nothing else names the service", () => {
		assert.strictEqual(resolveServiceName({ env: { npm_package_name: "pkg" } }), "pkg");
		assert.strictEqual(resolveServiceName({ env: {} }), "unknown-service");
	});

	it("ranks an attribute service.name above the package name", () => {
		assert.strictEqual(resolveServiceName({ env: { npm_package_name: "pkg", OTEL_RESOURCE_ATTRIBUTES: "service.name=from-attrs" } }), "from-attrs");
	});
});
