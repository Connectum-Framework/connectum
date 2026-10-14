/**
 * Semantic Conventions validation tests
 *
 * Validates that all RPC attribute names, metric names, event names,
 * and event attributes used in @connectum/otel match the OpenTelemetry
 * semantic conventions for RPC:
 *
 * @see https://opentelemetry.io/docs/specs/semconv/rpc/rpc-spans/
 * @see https://opentelemetry.io/docs/specs/semconv/rpc/rpc-metrics/
 * @see https://opentelemetry.io/docs/specs/semconv/rpc/connect-rpc/
 *
 * The expected names come from `@opentelemetry/semantic-conventions`, the
 * generated registry of the specification. The package under test never imports
 * its attribute, metric or event names from there (only the service-name keys
 * of the resource), so the registry is an independent source and a name
 * changed in `src` cannot drag the expectation along. Units ("s", "By") are
 * the ones the RPC metrics specification lists; the registry does not carry them.
 */

// Disable real exporters for tests (must be set before any OTel import)
process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { describe, it } from "node:test";
import * as semconv from "@opentelemetry/semantic-conventions/incubating";
import * as attributes from "../../src/attributes.ts";
import {
	ATTR_ERROR_TYPE,
	ATTR_NETWORK_PEER_ADDRESS,
	ATTR_NETWORK_PEER_PORT,
	ATTR_NETWORK_PROTOCOL_NAME,
	ATTR_NETWORK_TRANSPORT,
	ATTR_RPC_MESSAGE_ID,
	ATTR_RPC_MESSAGE_TYPE,
	ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE,
	ATTR_RPC_METHOD,
	ATTR_RPC_RESPONSE_STATUS_CODE,
	ATTR_RPC_SYSTEM_NAME,
	ATTR_SERVER_ADDRESS,
	ATTR_SERVER_PORT,
	RPC_MESSAGE_EVENT,
} from "../../src/attributes.ts";
import {
	createRpcClientMetrics,
	createRpcServerMetrics,
} from "../../src/metrics.ts";

// ---------------------------------------------------------------------------
// Mock Meter helper
// ---------------------------------------------------------------------------

interface RecordedHistogram {
	name: string;
	options: { unit?: string; description?: string } | undefined;
}

function createMockMeter() {
	const histograms: RecordedHistogram[] = [];
	return {
		meter: {
			createHistogram(
				name: string,
				options?: { unit?: string; description?: string },
			) {
				histograms.push({ name, options });
				return { record() {} };
			},
		} as any,
		histograms,
	};
}

// ---------------------------------------------------------------------------
// 1. RPC event names
// ---------------------------------------------------------------------------

describe("Semantic Conventions: RPC event names", () => {
	it("RPC_MESSAGE_EVENT should equal 'rpc.message' per OTel semconv", () => {
		assert.strictEqual(RPC_MESSAGE_EVENT, semconv.EVENT_RPC_MESSAGE);
	});
});

// ---------------------------------------------------------------------------
// 2. RPC event attributes
// ---------------------------------------------------------------------------

describe("Semantic Conventions: RPC event attributes", () => {
	it("ATTR_RPC_MESSAGE_TYPE should equal 'rpc.message.type'", () => {
		assert.strictEqual(ATTR_RPC_MESSAGE_TYPE, semconv.ATTR_RPC_MESSAGE_TYPE);
	});

	it("ATTR_RPC_MESSAGE_ID should equal 'rpc.message.id'", () => {
		assert.strictEqual(ATTR_RPC_MESSAGE_ID, semconv.ATTR_RPC_MESSAGE_ID);
	});

	it("ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE should equal 'rpc.message.uncompressed_size'", () => {
		assert.strictEqual(ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE, semconv.ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE);
	});

	it("the event attributes are exactly the registry's type, id and uncompressed size", () => {
		// A set comparison, not a prefix check: a constant renamed to another
		// 'rpc.message.*' key, or a fourth key added, changes the set.
		assert.deepStrictEqual(
			[ATTR_RPC_MESSAGE_TYPE, ATTR_RPC_MESSAGE_ID, ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE].sort(),
			[semconv.ATTR_RPC_MESSAGE_TYPE, semconv.ATTR_RPC_MESSAGE_ID, semconv.ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE].sort(),
		);
	});
});

// ---------------------------------------------------------------------------
// 3. Metric names
// ---------------------------------------------------------------------------

describe("Semantic Conventions: metric names", () => {
	describe("RPC server metrics", () => {
		it("should create 'rpc.server.call.duration' histogram with unit 's'", () => {
			const { meter, histograms } = createMockMeter();
			createRpcServerMetrics(meter);

			const duration = histograms.find(
				(h) => h.name === semconv.METRIC_RPC_SERVER_CALL_DURATION,
			);
			assert.ok(duration, "rpc.server.call.duration histogram must exist");
			assert.strictEqual(
				duration.options?.unit,
				"s",
				"Duration unit must be 's' (seconds)",
			);
		});

		it("should create 'rpc.server.request.size' histogram with unit 'By'", () => {
			const { meter, histograms } = createMockMeter();
			createRpcServerMetrics(meter);

			const requestSize = histograms.find(
				(h) => h.name === semconv.METRIC_RPC_SERVER_REQUEST_SIZE,
			);
			assert.ok(requestSize, "rpc.server.request.size histogram must exist");
			assert.strictEqual(
				requestSize.options?.unit,
				"By",
				"Request size unit must be 'By' (bytes)",
			);
		});

		it("should create 'rpc.server.response.size' histogram with unit 'By'", () => {
			const { meter, histograms } = createMockMeter();
			createRpcServerMetrics(meter);

			const responseSize = histograms.find(
				(h) => h.name === semconv.METRIC_RPC_SERVER_RESPONSE_SIZE,
			);
			assert.ok(responseSize, "rpc.server.response.size histogram must exist");
			assert.strictEqual(
				responseSize.options?.unit,
				"By",
				"Response size unit must be 'By' (bytes)",
			);
		});

		it("should create exactly 3 server histograms", () => {
			const { meter, histograms } = createMockMeter();
			createRpcServerMetrics(meter);

			assert.strictEqual(
				histograms.length,
				3,
				"createRpcServerMetrics should create exactly 3 histograms",
			);
		});
	});

	describe("RPC client metrics", () => {
		it("should create 'rpc.client.call.duration' histogram with unit 's'", () => {
			const { meter, histograms } = createMockMeter();
			createRpcClientMetrics(meter);

			const duration = histograms.find(
				(h) => h.name === semconv.METRIC_RPC_CLIENT_CALL_DURATION,
			);
			assert.ok(duration, "rpc.client.call.duration histogram must exist");
			assert.strictEqual(
				duration.options?.unit,
				"s",
				"Duration unit must be 's' (seconds)",
			);
		});

		it("should create 'rpc.client.request.size' histogram with unit 'By'", () => {
			const { meter, histograms } = createMockMeter();
			createRpcClientMetrics(meter);

			const requestSize = histograms.find(
				(h) => h.name === semconv.METRIC_RPC_CLIENT_REQUEST_SIZE,
			);
			assert.ok(requestSize, "rpc.client.request.size histogram must exist");
			assert.strictEqual(
				requestSize.options?.unit,
				"By",
				"Request size unit must be 'By' (bytes)",
			);
		});

		it("should create 'rpc.client.response.size' histogram with unit 'By'", () => {
			const { meter, histograms } = createMockMeter();
			createRpcClientMetrics(meter);

			const responseSize = histograms.find(
				(h) => h.name === semconv.METRIC_RPC_CLIENT_RESPONSE_SIZE,
			);
			assert.ok(responseSize, "rpc.client.response.size histogram must exist");
			assert.strictEqual(
				responseSize.options?.unit,
				"By",
				"Response size unit must be 'By' (bytes)",
			);
		});

		it("should create exactly 3 client histograms", () => {
			const { meter, histograms } = createMockMeter();
			createRpcClientMetrics(meter);

			assert.strictEqual(
				histograms.length,
				3,
				"createRpcClientMetrics should create exactly 3 histograms",
			);
		});
	});

	describe("metric set", () => {
		// The whole (name, unit) set is compared, so an extra or renamed instrument is
		// visible; a prefix check would pass for any name under the namespace.
		it("the server instruments are exactly the registry's duration, request size and response size", () => {
			const { meter, histograms } = createMockMeter();
			createRpcServerMetrics(meter);

			assert.deepStrictEqual(
				histograms.map((h) => [h.name, h.options?.unit]).sort(),
				[
					[semconv.METRIC_RPC_SERVER_CALL_DURATION, "s"],
					[semconv.METRIC_RPC_SERVER_REQUEST_SIZE, "By"],
					[semconv.METRIC_RPC_SERVER_RESPONSE_SIZE, "By"],
				].sort(),
			);
		});

		it("the client instruments are exactly the registry's duration, request size and response size", () => {
			const { meter, histograms } = createMockMeter();
			createRpcClientMetrics(meter);

			assert.deepStrictEqual(
				histograms.map((h) => [h.name, h.options?.unit]).sort(),
				[
					[semconv.METRIC_RPC_CLIENT_CALL_DURATION, "s"],
					[semconv.METRIC_RPC_CLIENT_REQUEST_SIZE, "By"],
					[semconv.METRIC_RPC_CLIENT_RESPONSE_SIZE, "By"],
				].sort(),
			);
		});
	});
});

// ---------------------------------------------------------------------------
// 4. Attribute names
// ---------------------------------------------------------------------------

describe("Semantic Conventions: attribute names", () => {
	describe("RPC attributes", () => {
		const rpcAttributes = [
			{ constant: ATTR_RPC_SYSTEM_NAME, expected: semconv.ATTR_RPC_SYSTEM_NAME, name: "ATTR_RPC_SYSTEM_NAME" },
			{ constant: ATTR_RPC_METHOD, expected: semconv.ATTR_RPC_METHOD, name: "ATTR_RPC_METHOD" },
			{
				constant: ATTR_RPC_RESPONSE_STATUS_CODE,
				expected: semconv.ATTR_RPC_RESPONSE_STATUS_CODE,
				name: "ATTR_RPC_RESPONSE_STATUS_CODE",
			},
		];

		for (const { constant, expected, name } of rpcAttributes) {
			it(`${name} should equal '${expected}'`, () => {
				assert.strictEqual(constant, expected);
			});
		}
	});

	describe("error attributes", () => {
		it("ATTR_ERROR_TYPE should equal 'error.type'", () => {
			assert.strictEqual(ATTR_ERROR_TYPE, semconv.ATTR_ERROR_TYPE);
		});
	});

	describe("server attributes", () => {
		const serverAttributes = [
			{ constant: ATTR_SERVER_ADDRESS, expected: semconv.ATTR_SERVER_ADDRESS, name: "ATTR_SERVER_ADDRESS" },
			{ constant: ATTR_SERVER_PORT, expected: semconv.ATTR_SERVER_PORT, name: "ATTR_SERVER_PORT" },
		];

		for (const { constant, expected, name } of serverAttributes) {
			it(`${name} should equal '${expected}'`, () => {
				assert.strictEqual(constant, expected);
			});
		}
	});

	describe("network attributes", () => {
		const networkAttributes = [
			{
				constant: ATTR_NETWORK_PROTOCOL_NAME,
				expected: semconv.ATTR_NETWORK_PROTOCOL_NAME,
				name: "ATTR_NETWORK_PROTOCOL_NAME",
			},
			{
				constant: ATTR_NETWORK_TRANSPORT,
				expected: semconv.ATTR_NETWORK_TRANSPORT,
				name: "ATTR_NETWORK_TRANSPORT",
			},
			{
				constant: ATTR_NETWORK_PEER_ADDRESS,
				expected: semconv.ATTR_NETWORK_PEER_ADDRESS,
				name: "ATTR_NETWORK_PEER_ADDRESS",
			},
			{
				constant: ATTR_NETWORK_PEER_PORT,
				expected: semconv.ATTR_NETWORK_PEER_PORT,
				name: "ATTR_NETWORK_PEER_PORT",
			},
		];

		for (const { constant, expected, name } of networkAttributes) {
			it(`${name} should equal '${expected}'`, () => {
				assert.strictEqual(constant, expected);
			});
		}
	});

	describe("attribute namespace compliance", () => {
		// Every key the package exports inside a standard namespace has to exist in the
		// registry of that namespace. A prefix check on the same constants cannot fail
		// for a key that merely stays under the prefix; membership in the registry can.
		const registryKeys = new Set(Object.values(semconv).filter((value): value is string => typeof value === "string"));
		const exportedKeys = Object.values(attributes).filter((value): value is string => typeof value === "string");

		const namespaces = [
			{ prefix: "rpc.", known: [ATTR_RPC_SYSTEM_NAME, ATTR_RPC_METHOD, ATTR_RPC_RESPONSE_STATUS_CODE, RPC_MESSAGE_EVENT, ATTR_RPC_MESSAGE_TYPE] },
			{ prefix: "server.", known: [ATTR_SERVER_ADDRESS, ATTR_SERVER_PORT] },
			{ prefix: "network.", known: [ATTR_NETWORK_PROTOCOL_NAME, ATTR_NETWORK_TRANSPORT, ATTR_NETWORK_PEER_ADDRESS, ATTR_NETWORK_PEER_PORT] },
			{ prefix: "error.", known: [ATTR_ERROR_TYPE] },
		];

		for (const { prefix, known } of namespaces) {
			it(`every exported '${prefix}*' key exists in the semantic-conventions registry`, () => {
				const inNamespace = exportedKeys.filter((key) => key.startsWith(prefix));

				// The filter must see the constants it is meant to police.
				for (const key of known) {
					assert.ok(inNamespace.includes(key), `'${key}' should be among the exported '${prefix}*' keys`);
				}
				for (const key of inNamespace) {
					assert.ok(registryKeys.has(key), `'${key}' is not a key of the semantic-conventions registry`);
				}
			});
		}
	});
});
