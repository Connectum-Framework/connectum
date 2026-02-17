/**
 * Shared utilities unit tests
 *
 * Tests helper functions used by both server and client OTel interceptors:
 * - estimateMessageSize() -- protobuf message byte length estimation
 * - buildErrorAttributes() -- error-specific OTel attributes
 * - buildBaseAttributes() -- standard RPC base attributes
 * - applyAttributeFilter() -- attribute filtering
 */

// Disable real exporters for tests (must be set before any OTel import)
process.env.OTEL_TRACES_EXPORTER = "none";
process.env.OTEL_METRICS_EXPORTER = "none";
process.env.OTEL_LOGS_EXPORTER = "none";

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import {
	ATTR_ERROR_TYPE,
	ATTR_NETWORK_PROTOCOL_NAME,
	ATTR_NETWORK_TRANSPORT,
	ATTR_RPC_CONNECT_RPC_STATUS_CODE,
	ATTR_RPC_METHOD,
	ATTR_RPC_SERVICE,
	ATTR_RPC_SYSTEM,
	ATTR_SERVER_ADDRESS,
	ATTR_SERVER_PORT,
	RPC_SYSTEM_CONNECT_RPC,
} from "../../src/attributes.ts";
import {
	applyAttributeFilter,
	buildBaseAttributes,
	buildErrorAttributes,
	estimateMessageSize,
} from "../../src/shared.ts";

// ---------------------------------------------------------------------------
// estimateMessageSize()
// ---------------------------------------------------------------------------

describe("estimateMessageSize", () => {
	it("should return 0 for null", () => {
		assert.strictEqual(estimateMessageSize(null), 0);
	});

	it("should return 0 for undefined", () => {
		assert.strictEqual(estimateMessageSize(undefined), 0);
	});

	it("should return byte length when message has toBinary()", () => {
		const message = {
			toBinary: () => new Uint8Array(42),
		};

		assert.strictEqual(estimateMessageSize(message), 42);
	});

	it("should return 0 when message has no toBinary()", () => {
		const message = { someField: "value" };

		assert.strictEqual(estimateMessageSize(message), 0);
	});

	it("should return 0 for empty binary (new Uint8Array(0))", () => {
		const message = {
			toBinary: () => new Uint8Array(0),
		};

		assert.strictEqual(estimateMessageSize(message), 0);
	});

	it("should return correct length for non-trivial binary", () => {
		const binaryData = new Uint8Array([0x08, 0x96, 0x01, 0x12, 0x07]);
		const message = {
			toBinary: () => binaryData,
		};

		assert.strictEqual(estimateMessageSize(message), 5);
	});
});

// ---------------------------------------------------------------------------
// buildErrorAttributes()
// ---------------------------------------------------------------------------

describe("buildErrorAttributes", () => {
	it("should return error.type=ConnectErrorCodeName + rpc.connect_rpc.status_code for ConnectError", () => {
		const error = new ConnectError("not found", Code.NotFound);
		const attrs = buildErrorAttributes(error);

		assert.strictEqual(attrs[ATTR_ERROR_TYPE], "NOT_FOUND");
		assert.strictEqual(attrs[ATTR_RPC_CONNECT_RPC_STATUS_CODE], Code.NotFound);
	});

	it("should return error.type=constructor name for generic Error", () => {
		const error = new TypeError("bad type");
		const attrs = buildErrorAttributes(error);

		assert.strictEqual(attrs[ATTR_ERROR_TYPE], "TypeError");
		assert.strictEqual(
			attrs[ATTR_RPC_CONNECT_RPC_STATUS_CODE],
			undefined,
			"should not include rpc.connect_rpc.status_code for generic Error",
		);
	});

	it("should return error.type='UNKNOWN' for non-Error values (string)", () => {
		const attrs = buildErrorAttributes("something went wrong");

		assert.strictEqual(attrs[ATTR_ERROR_TYPE], "UNKNOWN");
	});

	it("should return error.type='UNKNOWN' for non-Error values (number)", () => {
		const attrs = buildErrorAttributes(42);

		assert.strictEqual(attrs[ATTR_ERROR_TYPE], "UNKNOWN");
	});

	it("should return error.type='UNKNOWN' for non-Error values (null)", () => {
		const attrs = buildErrorAttributes(null);

		assert.strictEqual(attrs[ATTR_ERROR_TYPE], "UNKNOWN");
	});

	it("should handle ConnectError with Code.NotFound (5)", () => {
		const error = new ConnectError("not found", Code.NotFound);
		const attrs = buildErrorAttributes(error);

		assert.strictEqual(attrs[ATTR_ERROR_TYPE], "NOT_FOUND");
		assert.strictEqual(attrs[ATTR_RPC_CONNECT_RPC_STATUS_CODE], 5);
	});

	it("should handle ConnectError with Code.Internal (13)", () => {
		const error = new ConnectError("internal error", Code.Internal);
		const attrs = buildErrorAttributes(error);

		assert.strictEqual(attrs[ATTR_ERROR_TYPE], "INTERNAL");
		assert.strictEqual(attrs[ATTR_RPC_CONNECT_RPC_STATUS_CODE], 13);
	});

	it("should handle ConnectError with Code.InvalidArgument (3)", () => {
		const error = new ConnectError("bad argument", Code.InvalidArgument);
		const attrs = buildErrorAttributes(error);

		assert.strictEqual(attrs[ATTR_ERROR_TYPE], "INVALID_ARGUMENT");
		assert.strictEqual(attrs[ATTR_RPC_CONNECT_RPC_STATUS_CODE], 3);
	});
});

// ---------------------------------------------------------------------------
// buildBaseAttributes()
// ---------------------------------------------------------------------------

describe("buildBaseAttributes", () => {
	it("should return correct base attributes with required fields", () => {
		const attrs = buildBaseAttributes({
			service: "test.TestService",
			method: "TestMethod",
			serverAddress: "localhost",
		});

		assert.strictEqual(attrs[ATTR_RPC_SYSTEM], RPC_SYSTEM_CONNECT_RPC);
		assert.strictEqual(attrs[ATTR_RPC_SERVICE], "test.TestService");
		assert.strictEqual(attrs[ATTR_RPC_METHOD], "TestMethod");
		assert.strictEqual(attrs[ATTR_SERVER_ADDRESS], "localhost");
		assert.strictEqual(attrs[ATTR_NETWORK_PROTOCOL_NAME], "connect_rpc");
		assert.strictEqual(attrs[ATTR_NETWORK_TRANSPORT], "tcp");
	});

	it("should include server.port when provided", () => {
		const attrs = buildBaseAttributes({
			service: "test.TestService",
			method: "TestMethod",
			serverAddress: "localhost",
			serverPort: 5000,
		});

		assert.strictEqual(attrs[ATTR_SERVER_PORT], 5000);
	});

	it("should not include server.port when undefined", () => {
		const attrs = buildBaseAttributes({
			service: "test.TestService",
			method: "TestMethod",
			serverAddress: "localhost",
		});

		assert.strictEqual(
			ATTR_SERVER_PORT in attrs,
			false,
			"server.port key should not be present",
		);
	});

	it("should always include rpc.system, rpc.service, rpc.method, server.address, network.protocol.name, network.transport", () => {
		const attrs = buildBaseAttributes({
			service: "my.Service",
			method: "MyMethod",
			serverAddress: "192.168.1.1",
		});

		const expectedKeys = [
			ATTR_RPC_SYSTEM,
			ATTR_RPC_SERVICE,
			ATTR_RPC_METHOD,
			ATTR_SERVER_ADDRESS,
			ATTR_NETWORK_PROTOCOL_NAME,
			ATTR_NETWORK_TRANSPORT,
		];

		for (const key of expectedKeys) {
			assert.ok(key in attrs, `attribute '${key}' should be present`);
		}
	});
});

// ---------------------------------------------------------------------------
// applyAttributeFilter()
// ---------------------------------------------------------------------------

describe("applyAttributeFilter", () => {
	it("should return attrs unchanged when no filter", () => {
		const attrs = {
			[ATTR_RPC_SYSTEM]: RPC_SYSTEM_CONNECT_RPC,
			[ATTR_RPC_SERVICE]: "test.Service",
			[ATTR_RPC_METHOD]: "Method",
		};

		const result = applyAttributeFilter(attrs);

		assert.deepStrictEqual(result, attrs);
	});

	it("should filter attributes based on filter function", () => {
		const attrs = {
			[ATTR_RPC_SYSTEM]: RPC_SYSTEM_CONNECT_RPC,
			[ATTR_RPC_SERVICE]: "test.Service",
			[ATTR_SERVER_PORT]: 5000,
		};

		const result = applyAttributeFilter(attrs, (key) => key !== ATTR_SERVER_PORT);

		assert.deepStrictEqual(result, {
			[ATTR_RPC_SYSTEM]: RPC_SYSTEM_CONNECT_RPC,
			[ATTR_RPC_SERVICE]: "test.Service",
		});
	});

	it("should return empty object when filter blocks all", () => {
		const attrs = {
			[ATTR_RPC_SYSTEM]: RPC_SYSTEM_CONNECT_RPC,
			[ATTR_RPC_SERVICE]: "test.Service",
		};

		const result = applyAttributeFilter(attrs, () => false);

		assert.deepStrictEqual(result, {});
	});

	it("should return all when filter allows all", () => {
		const attrs = {
			[ATTR_RPC_SYSTEM]: RPC_SYSTEM_CONNECT_RPC,
			[ATTR_RPC_SERVICE]: "test.Service",
			[ATTR_RPC_METHOD]: "Method",
			[ATTR_SERVER_ADDRESS]: "localhost",
		};

		const result = applyAttributeFilter(attrs, () => true);

		assert.deepStrictEqual(result, attrs);
	});
});
