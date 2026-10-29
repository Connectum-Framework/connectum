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
import { create } from "@bufbuild/protobuf";
import { Code, ConnectError } from "@connectrpc/connect";
import { ItemSchema } from "../../../testing/tests/fixtures/streaming/v1/streaming_pb.ts";
import {
	ATTR_RPC_METHOD,
	ATTR_RPC_SYSTEM_NAME,
	ATTR_SERVER_ADDRESS,
	ATTR_SERVER_PORT,
	RPC_SYSTEM_NAME_CONNECTRPC,
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
	// Oracle: the protobuf wire format. A message `{ value: "abc", sequence: 150 }` of
	// streaming.v1.Item is field 1 (tag 0x0a, length 3, "abc") and field 2 (tag 0x10,
	// varint 150 = 0x96 0x01): 2 + 3 + 1 + 2 = 8 bytes. The bytes are written out here,
	// not produced by the library under test.
	it("should measure a protobuf-es v2 message by the serialized length under its schema", () => {
		const message = create(ItemSchema, { value: "abc", sequence: 150 });

		assert.strictEqual(typeof (message as { toBinary?: unknown }).toBinary, "undefined", "a v2 message has no toBinary() method");
		assert.strictEqual(estimateMessageSize(message, ItemSchema), 8);
	});

	it("should report 0 for an empty v2 message, whose serialized form has no bytes", () => {
		assert.strictEqual(estimateMessageSize(create(ItemSchema), ItemSchema), 0);
	});

	it("should report 0 for a v2 message when its schema is not known", () => {
		assert.strictEqual(estimateMessageSize(create(ItemSchema, { value: "abc" })), 0);
	});

	it("should not throw and report 0 for an object that is not a message of the schema", () => {
		assert.strictEqual(estimateMessageSize({ total: 3 }, ItemSchema), 0);
		assert.strictEqual(estimateMessageSize(42, ItemSchema), 0);
	});

	it("should fall back to the toBinary() method of a message that the schema cannot serialize", () => {
		assert.strictEqual(estimateMessageSize({ toBinary: () => new Uint8Array(7) }, ItemSchema), 7);
	});

	it("should report 0 for a toBinary() method that throws", () => {
		const message = {
			toBinary: () => {
				throw new Error("cannot serialize");
			},
		};

		assert.strictEqual(estimateMessageSize(message), 0);
	});

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

	// The size of a message that cannot be serialized is unknown. Reporting 0 for it
	// is a Connectum decision (documented on estimateMessageSize); semconv does not
	// prescribe a value for an unknown size.
	it("should report 0 as the Connectum size for a message without toBinary()", () => {
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
	it("should return error.type=ConnectErrorCodeName + rpc.response.status_code for ConnectError", () => {
		const error = new ConnectError("not found", Code.NotFound);
		const attrs = buildErrorAttributes(error);

		assert.deepStrictEqual(attrs, { "error.type": "NOT_FOUND", "rpc.response.status_code": "NOT_FOUND" });
	});

	// The Connect wire codes are the gRPC status numbers; the names are the canonical
	// upper-case spellings that the metrics guide documents for `rpc.response.status_code`,
	// with `error.type` equal to it. The numbers are written out here, not read from `Code`.
	// Code 1 is the Connect spelling "CANCELED" (one L), as the Connect protocol, Connect-ES and
	// otelconnect-go name it; "CANCELLED" is the gRPC spelling and is deliberately not used.
	const connectCodeNames: Array<[number, string]> = [
		[1, "CANCELED"],
		[2, "UNKNOWN"],
		[3, "INVALID_ARGUMENT"],
		[4, "DEADLINE_EXCEEDED"],
		[5, "NOT_FOUND"],
		[6, "ALREADY_EXISTS"],
		[7, "PERMISSION_DENIED"],
		[8, "RESOURCE_EXHAUSTED"],
		[9, "FAILED_PRECONDITION"],
		[10, "ABORTED"],
		[11, "OUT_OF_RANGE"],
		[12, "UNIMPLEMENTED"],
		[13, "INTERNAL"],
		[14, "UNAVAILABLE"],
		[15, "DATA_LOSS"],
		[16, "UNAUTHENTICATED"],
	];

	for (const [code, name] of connectCodeNames) {
		it(`names Connect error code ${code} ${name} in both error.type and rpc.response.status_code`, () => {
			const attrs = buildErrorAttributes(new ConnectError("failure", code));

			assert.deepStrictEqual(attrs, { "error.type": name, "rpc.response.status_code": name });
		});
	}

	it("should return error.type=constructor name for generic Error and no status code", () => {
		const attrs = buildErrorAttributes(new TypeError("bad type"));

		assert.deepStrictEqual(attrs, { "error.type": "TypeError" });
	});

	// Oracle: the semantic conventions ask for a non-empty, low-cardinality error.type,
	// and name `_OTHER` as the fallback when the instrumentation has nothing better.
	it("should fall back to the error's name when its class is anonymous", () => {
		const Anonymous = (() => class extends Error {})();
		assert.strictEqual(Anonymous.name, "", "the fixture class has an empty name");

		assert.deepStrictEqual(buildErrorAttributes(new Anonymous("x")), { "error.type": "Error" });
	});

	it("should fall back to _OTHER when neither the class nor the error has a name", () => {
		const Anonymous = (() => class extends Error {})();
		const error = new Anonymous("x");
		error.name = "";

		assert.deepStrictEqual(buildErrorAttributes(error), { "error.type": "_OTHER" });
	});

	// The metrics guide: error.type is the error class name for another Error, "otherwise UNKNOWN".
	const notErrors: Array<[string, unknown]> = [
		["a string", "something went wrong"],
		["a number", 42],
		["null", null],
		["undefined", undefined],
		["a plain object", { message: "looks like an error" }],
	];

	for (const [label, value] of notErrors) {
		it(`reports only error.type UNKNOWN for ${label} thrown as a value`, () => {
			assert.deepStrictEqual(buildErrorAttributes(value), { "error.type": "UNKNOWN" });
		});
	}
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

		// Key spellings and values are those of the metrics guide's attribute table
		// (the OpenTelemetry RPC conventions for Connect), not the constants. The whole
		// set is compared, so a renamed, dropped or extra attribute (such as the
		// replaced rpc.service or rpc.system) fails.
		assert.deepStrictEqual(attrs, {
			"rpc.system.name": "connectrpc",
			"rpc.method": "test.TestService/TestMethod",
			"server.address": "localhost",
			"network.protocol.name": "connect_rpc",
			"network.transport": "tcp",
		});
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

	it("takes the method from the service and method it is given, and the address and port verbatim", () => {
		const attrs = buildBaseAttributes({
			service: "my.Service",
			method: "MyMethod",
			serverAddress: "192.168.1.1",
			serverPort: 8443,
		});

		assert.deepStrictEqual(attrs, {
			"rpc.system.name": "connectrpc",
			"rpc.method": "my.Service/MyMethod",
			"server.address": "192.168.1.1",
			"server.port": 8443,
			"network.protocol.name": "connect_rpc",
			"network.transport": "tcp",
		});
	});
});

// ---------------------------------------------------------------------------
// applyAttributeFilter()
// ---------------------------------------------------------------------------

describe("applyAttributeFilter", () => {
	const noReport = () => {};

	it("should drop an attribute whose filter call throws, keep the others, and report the error", () => {
		const reported: unknown[] = [];
		const attrs = {
			[ATTR_RPC_SYSTEM_NAME]: RPC_SYSTEM_NAME_CONNECTRPC,
			[ATTR_SERVER_PORT]: 5000,
		};

		const result = applyAttributeFilter(
			attrs,
			(key) => {
				if (key === ATTR_SERVER_PORT) throw new Error("filter bug");
				return true;
			},
			(hook, error) => reported.push([hook, (error as Error).message]),
		);

		assert.deepStrictEqual(result, { [ATTR_RPC_SYSTEM_NAME]: RPC_SYSTEM_NAME_CONNECTRPC });
		assert.deepStrictEqual(reported, [["attributeFilter", "filter bug"]]);
	});

	it("should return attrs unchanged when no filter", () => {
		const attrs = {
			[ATTR_RPC_SYSTEM_NAME]: RPC_SYSTEM_NAME_CONNECTRPC,
			[ATTR_RPC_METHOD]: "Method",
		};

		const result = applyAttributeFilter(attrs, undefined, noReport);

		assert.deepStrictEqual(result, attrs);
	});

	it("should filter attributes based on filter function", () => {
		const attrs = {
			[ATTR_RPC_SYSTEM_NAME]: RPC_SYSTEM_NAME_CONNECTRPC,
			[ATTR_SERVER_PORT]: 5000,
		};

		const result = applyAttributeFilter(attrs, (key) => key !== ATTR_SERVER_PORT, noReport);

		assert.deepStrictEqual(result, {
			[ATTR_RPC_SYSTEM_NAME]: RPC_SYSTEM_NAME_CONNECTRPC,
		});
	});

	it("should return empty object when filter blocks all", () => {
		const attrs = {
			[ATTR_RPC_SYSTEM_NAME]: RPC_SYSTEM_NAME_CONNECTRPC,
		};

		const result = applyAttributeFilter(attrs, () => false, noReport);

		assert.deepStrictEqual(result, {});
	});

	it("should return all when filter allows all", () => {
		const attrs = {
			[ATTR_RPC_SYSTEM_NAME]: RPC_SYSTEM_NAME_CONNECTRPC,
			[ATTR_RPC_METHOD]: "Method",
			[ATTR_SERVER_ADDRESS]: "localhost",
		};

		const result = applyAttributeFilter(attrs, () => true, noReport);

		assert.deepStrictEqual(result, attrs);
	});
});
