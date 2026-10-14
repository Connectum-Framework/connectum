/**
 * Attributes module tests
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { Code } from "@connectrpc/connect";
import {
	ATTR_ERROR_TYPE,
	ATTR_RPC_METHOD,
	ATTR_RPC_RESPONSE_STATUS_CODE,
	ATTR_RPC_SYSTEM_NAME,
	ATTR_SERVER_ADDRESS,
	ATTR_SERVER_PORT,
	ConnectErrorCode,
	ConnectErrorCodeName,
	RPC_SYSTEM_NAME_CONNECTRPC,
} from "../../src/attributes.ts";

describe("attributes", () => {
	describe("RPC attribute keys", () => {
		it("ATTR_RPC_SYSTEM_NAME should equal 'rpc.system.name'", () => {
			assert.strictEqual(ATTR_RPC_SYSTEM_NAME, "rpc.system.name");
		});

		it("ATTR_RPC_METHOD should equal 'rpc.method'", () => {
			assert.strictEqual(ATTR_RPC_METHOD, "rpc.method");
		});

		it("ATTR_RPC_RESPONSE_STATUS_CODE should equal 'rpc.response.status_code'", () => {
			assert.strictEqual(ATTR_RPC_RESPONSE_STATUS_CODE, "rpc.response.status_code");
		});

		it("ATTR_ERROR_TYPE should equal 'error.type'", () => {
			assert.strictEqual(ATTR_ERROR_TYPE, "error.type");
		});

		it("ATTR_SERVER_ADDRESS should equal 'server.address'", () => {
			assert.strictEqual(ATTR_SERVER_ADDRESS, "server.address");
		});

		it("ATTR_SERVER_PORT should equal 'server.port'", () => {
			assert.strictEqual(ATTR_SERVER_PORT, "server.port");
		});
	});

	describe("RPC_SYSTEM_NAME_CONNECTRPC", () => {
		it("should equal 'connectrpc'", () => {
			assert.strictEqual(RPC_SYSTEM_NAME_CONNECTRPC, "connectrpc");
		});
	});

	describe("ConnectErrorCode", () => {
		it("should contain all 16 error codes with correct values", () => {
			const expectedCodes: Record<string, number> = {
				CANCELED: 1,
				UNKNOWN: 2,
				INVALID_ARGUMENT: 3,
				DEADLINE_EXCEEDED: 4,
				NOT_FOUND: 5,
				ALREADY_EXISTS: 6,
				PERMISSION_DENIED: 7,
				RESOURCE_EXHAUSTED: 8,
				FAILED_PRECONDITION: 9,
				ABORTED: 10,
				OUT_OF_RANGE: 11,
				UNIMPLEMENTED: 12,
				INTERNAL: 13,
				UNAVAILABLE: 14,
				DATA_LOSS: 15,
				UNAUTHENTICATED: 16,
			};

			for (const [name, code] of Object.entries(expectedCodes)) {
				assert.strictEqual(
					ConnectErrorCode[name as keyof typeof ConnectErrorCode],
					code,
					`ConnectErrorCode.${name} should equal ${code}`,
				);
			}
		});

		it("should have exactly 16 entries", () => {
			assert.strictEqual(Object.keys(ConnectErrorCode).length, 16);
		});
	});

	describe("ConnectErrorCodeName", () => {
		// The Connect protocol (connectrpc.com/docs/protocol, "Error codes") fixes the
		// wire name of every code; the numeric values are the gRPC status codes.
		// The span attribute carries the same name in upper case (the observability
		// guide shows `NOT_FOUND`, `FAILED_PRECONDITION`). The table is spelled out
		// here instead of being derived from ConnectErrorCode, so a misspelt name
		// copied into both production maps cannot agree with itself.
		const PROTOCOL_CODES: ReadonlyArray<readonly [number, string]> = [
			[1, "canceled"],
			[2, "unknown"],
			[3, "invalid_argument"],
			[4, "deadline_exceeded"],
			[5, "not_found"],
			[6, "already_exists"],
			[7, "permission_denied"],
			[8, "resource_exhausted"],
			[9, "failed_precondition"],
			[10, "aborted"],
			[11, "out_of_range"],
			[12, "unimplemented"],
			[13, "internal"],
			[14, "unavailable"],
			[15, "data_loss"],
			[16, "unauthenticated"],
		];

		for (const [code, wireName] of PROTOCOL_CODES) {
			it(`should map code ${code} to ${wireName.toUpperCase()}`, () => {
				assert.strictEqual(ConnectErrorCodeName[code], wireName.toUpperCase());
			});

			it(`should agree with the Connect library on code ${code}`, () => {
				// `Code` of @connectrpc/connect is an independent source of the number-to-name pairing.
				assert.strictEqual(Code[code]?.toLowerCase(), wireName.replaceAll("_", ""));
			});
		}

		it("should have exactly 16 entries", () => {
			assert.strictEqual(Object.keys(ConnectErrorCodeName).length, 16);
		});
	});
});
