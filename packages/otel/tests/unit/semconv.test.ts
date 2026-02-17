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
 */

// Disable real exporters for tests (must be set before any OTel import)
process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	ATTR_ERROR_TYPE,
	ATTR_NETWORK_PEER_ADDRESS,
	ATTR_NETWORK_PEER_PORT,
	ATTR_NETWORK_PROTOCOL_NAME,
	ATTR_NETWORK_TRANSPORT,
	ATTR_RPC_CONNECT_RPC_STATUS_CODE,
	ATTR_RPC_MESSAGE_ID,
	ATTR_RPC_MESSAGE_TYPE,
	ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE,
	ATTR_RPC_METHOD,
	ATTR_RPC_SERVICE,
	ATTR_RPC_SYSTEM,
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
		assert.strictEqual(RPC_MESSAGE_EVENT, "rpc.message");
	});
});

// ---------------------------------------------------------------------------
// 2. RPC event attributes
// ---------------------------------------------------------------------------

describe("Semantic Conventions: RPC event attributes", () => {
	it("ATTR_RPC_MESSAGE_TYPE should equal 'rpc.message.type'", () => {
		assert.strictEqual(ATTR_RPC_MESSAGE_TYPE, "rpc.message.type");
	});

	it("ATTR_RPC_MESSAGE_ID should equal 'rpc.message.id'", () => {
		assert.strictEqual(ATTR_RPC_MESSAGE_ID, "rpc.message.id");
	});

	it("ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE should equal 'rpc.message.uncompressed_size'", () => {
		assert.strictEqual(ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE, "rpc.message.uncompressed_size");
	});

	it("all required event attributes must be in the 'rpc.message.*' namespace", () => {
		const requiredEventAttributes = [
			ATTR_RPC_MESSAGE_TYPE,
			ATTR_RPC_MESSAGE_ID,
			ATTR_RPC_MESSAGE_UNCOMPRESSED_SIZE,
		];

		for (const attr of requiredEventAttributes) {
			assert.ok(
				attr.startsWith("rpc.message."),
				`Event attribute '${attr}' must be in the 'rpc.message.*' namespace`,
			);
		}

		assert.strictEqual(requiredEventAttributes.length, 3);
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
				(h) => h.name === "rpc.server.call.duration",
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
				(h) => h.name === "rpc.server.request.size",
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
				(h) => h.name === "rpc.server.response.size",
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
				(h) => h.name === "rpc.client.call.duration",
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
				(h) => h.name === "rpc.client.request.size",
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
				(h) => h.name === "rpc.client.response.size",
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

	describe("metric naming pattern", () => {
		it("all server metrics should follow 'rpc.server.*' naming pattern", () => {
			const { meter, histograms } = createMockMeter();
			createRpcServerMetrics(meter);

			for (const h of histograms) {
				assert.ok(
					h.name.startsWith("rpc.server."),
					`Server metric '${h.name}' must start with 'rpc.server.'`,
				);
			}
		});

		it("all client metrics should follow 'rpc.client.*' naming pattern", () => {
			const { meter, histograms } = createMockMeter();
			createRpcClientMetrics(meter);

			for (const h of histograms) {
				assert.ok(
					h.name.startsWith("rpc.client."),
					`Client metric '${h.name}' must start with 'rpc.client.'`,
				);
			}
		});
	});
});

// ---------------------------------------------------------------------------
// 4. Attribute names
// ---------------------------------------------------------------------------

describe("Semantic Conventions: attribute names", () => {
	describe("RPC attributes", () => {
		const rpcAttributes = [
			{ constant: ATTR_RPC_SYSTEM, expected: "rpc.system", name: "ATTR_RPC_SYSTEM" },
			{ constant: ATTR_RPC_SERVICE, expected: "rpc.service", name: "ATTR_RPC_SERVICE" },
			{ constant: ATTR_RPC_METHOD, expected: "rpc.method", name: "ATTR_RPC_METHOD" },
			{
				constant: ATTR_RPC_CONNECT_RPC_STATUS_CODE,
				expected: "rpc.connect_rpc.status_code",
				name: "ATTR_RPC_CONNECT_RPC_STATUS_CODE",
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
			assert.strictEqual(ATTR_ERROR_TYPE, "error.type");
		});
	});

	describe("server attributes", () => {
		const serverAttributes = [
			{ constant: ATTR_SERVER_ADDRESS, expected: "server.address", name: "ATTR_SERVER_ADDRESS" },
			{ constant: ATTR_SERVER_PORT, expected: "server.port", name: "ATTR_SERVER_PORT" },
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
				expected: "network.protocol.name",
				name: "ATTR_NETWORK_PROTOCOL_NAME",
			},
			{
				constant: ATTR_NETWORK_TRANSPORT,
				expected: "network.transport",
				name: "ATTR_NETWORK_TRANSPORT",
			},
			{
				constant: ATTR_NETWORK_PEER_ADDRESS,
				expected: "network.peer.address",
				name: "ATTR_NETWORK_PEER_ADDRESS",
			},
			{
				constant: ATTR_NETWORK_PEER_PORT,
				expected: "network.peer.port",
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
		it("all RPC attributes should be in the 'rpc.*' namespace", () => {
			const rpcAttrs = [
				ATTR_RPC_SYSTEM,
				ATTR_RPC_SERVICE,
				ATTR_RPC_METHOD,
				ATTR_RPC_CONNECT_RPC_STATUS_CODE,
			];

			for (const attr of rpcAttrs) {
				assert.ok(
					attr.startsWith("rpc."),
					`Attribute '${attr}' must be in the 'rpc.*' namespace`,
				);
			}
		});

		it("all server attributes should be in the 'server.*' namespace", () => {
			const serverAttrs = [ATTR_SERVER_ADDRESS, ATTR_SERVER_PORT];

			for (const attr of serverAttrs) {
				assert.ok(
					attr.startsWith("server."),
					`Attribute '${attr}' must be in the 'server.*' namespace`,
				);
			}
		});

		it("all network attributes should be in the 'network.*' namespace", () => {
			const networkAttrs = [
				ATTR_NETWORK_PROTOCOL_NAME,
				ATTR_NETWORK_TRANSPORT,
				ATTR_NETWORK_PEER_ADDRESS,
				ATTR_NETWORK_PEER_PORT,
			];

			for (const attr of networkAttrs) {
				assert.ok(
					attr.startsWith("network."),
					`Attribute '${attr}' must be in the 'network.*' namespace`,
				);
			}
		});

		it("error.type should be in the 'error.*' namespace", () => {
			assert.ok(
				ATTR_ERROR_TYPE.startsWith("error."),
				`Attribute '${ATTR_ERROR_TYPE}' must be in the 'error.*' namespace`,
			);
		});
	});
});
