/**
 * Attributes module tests
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import {
	ATTR_ERROR_TYPE,
	ATTR_RPC_CONNECT_RPC_STATUS_CODE,
	ATTR_RPC_METHOD,
	ATTR_RPC_SERVICE,
	ATTR_RPC_SYSTEM,
	ATTR_SERVER_ADDRESS,
	ATTR_SERVER_PORT,
	ConnectErrorCode,
	ConnectErrorCodeName,
	RPC_SYSTEM_CONNECT_RPC,
} from "../../src/attributes.ts";

describe("attributes", () => {
	describe("RPC attribute keys", () => {
		it("ATTR_RPC_SYSTEM should equal 'rpc.system'", () => {
			assert.strictEqual(ATTR_RPC_SYSTEM, "rpc.system");
		});

		it("ATTR_RPC_SERVICE should equal 'rpc.service'", () => {
			assert.strictEqual(ATTR_RPC_SERVICE, "rpc.service");
		});

		it("ATTR_RPC_METHOD should equal 'rpc.method'", () => {
			assert.strictEqual(ATTR_RPC_METHOD, "rpc.method");
		});

		it("ATTR_RPC_CONNECT_RPC_STATUS_CODE should equal 'rpc.connect_rpc.status_code'", () => {
			assert.strictEqual(
				ATTR_RPC_CONNECT_RPC_STATUS_CODE,
				"rpc.connect_rpc.status_code",
			);
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

	describe("RPC_SYSTEM_CONNECT_RPC", () => {
		it("should equal 'connect_rpc'", () => {
			assert.strictEqual(RPC_SYSTEM_CONNECT_RPC, "connect_rpc");
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
		it("should be a correct reverse map of ConnectErrorCode", () => {
			for (const [name, code] of Object.entries(ConnectErrorCode)) {
				assert.strictEqual(
					ConnectErrorCodeName[code],
					name,
					`ConnectErrorCodeName[${code}] should equal '${name}'`,
				);
			}
		});

		it("should have exactly 16 entries", () => {
			assert.strictEqual(Object.keys(ConnectErrorCodeName).length, 16);
		});
	});
});
