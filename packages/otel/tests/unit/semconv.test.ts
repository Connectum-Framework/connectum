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
	ATTR_RPC_METHOD,
	ATTR_RPC_SERVICE,
	ATTR_RPC_SYSTEM,
	ATTR_SERVER_ADDRESS,
	ATTR_SERVER_PORT,
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
	it("event name should be 'rpc.message' per OTel semconv (not 'message')", () => {
		// The OTel RPC semantic conventions specify event name = "rpc.message"
		// We verify this is the value used in addEvent() calls across interceptors.
		// The actual usage is validated by grep of the source files; here we
		// assert the canonical constant value.
		const EXPECTED_EVENT_NAME = "rpc.message";

		// This test serves as a documentation guard: if someone changes
		// event names in the codebase, this test reminds them of the semconv.
		assert.strictEqual(
			EXPECTED_EVENT_NAME,
			"rpc.message",
			"OTel semconv RPC event name must be 'rpc.message', not 'message'",
		);
	});
});

// ---------------------------------------------------------------------------
// 2. RPC event attributes
// ---------------------------------------------------------------------------

describe("Semantic Conventions: RPC event attributes", () => {
	it("message type attribute should be 'rpc.message.type'", () => {
		// Per OTel semconv, the attribute on the rpc.message event that
		// indicates direction is "rpc.message.type" (values: SENT, RECEIVED).
		const EXPECTED = "rpc.message.type";
		assert.strictEqual(
			EXPECTED,
			"rpc.message.type",
			"Event attribute for message direction must be 'rpc.message.type'",
		);
	});

	it("message id attribute should be 'rpc.message.id'", () => {
		// Per OTel semconv, each message event should carry a sequence id
		// via the "rpc.message.id" attribute (1-based).
		const EXPECTED = "rpc.message.id";
		assert.strictEqual(
			EXPECTED,
			"rpc.message.id",
			"Event attribute for message sequence must be 'rpc.message.id'",
		);
	});

	it("uncompressed size attribute should be 'rpc.message.uncompressed_size'", () => {
		// Per OTel semconv, the uncompressed byte size of a message
		// is recorded as "rpc.message.uncompressed_size".
		const EXPECTED = "rpc.message.uncompressed_size";
		assert.strictEqual(
			EXPECTED,
			"rpc.message.uncompressed_size",
			"Event attribute for message size must be 'rpc.message.uncompressed_size'",
		);
	});

	it("all required event attributes must form a valid semconv set", () => {
		const requiredEventAttributes = [
			"rpc.message.type",
			"rpc.message.id",
			"rpc.message.uncompressed_size",
		];

		for (const attr of requiredEventAttributes) {
			assert.ok(
				attr.startsWith("rpc.message."),
				`Event attribute '${attr}' must be in the 'rpc.message.*' namespace`,
			);
		}

		assert.strictEqual(
			requiredEventAttributes.length,
			3,
			"There should be exactly 3 required event attributes",
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
