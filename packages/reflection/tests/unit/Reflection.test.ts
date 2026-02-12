import assert from "node:assert";
import { describe, it } from "node:test";
import { Reflection } from "../../src/Reflection.ts";

describe("Reflection", () => {
	it("should return a ProtocolRegistration", () => {
		const protocol = Reflection();

		assert.strictEqual(protocol.name, "reflection");
		assert.strictEqual(typeof protocol.register, "function");
	});

	it("should not have an httpHandler", () => {
		const protocol = Reflection();

		assert.strictEqual(protocol.httpHandler, undefined);
	});

	it("should return separate instances per call", () => {
		const protocol1 = Reflection();
		const protocol2 = Reflection();

		assert.notStrictEqual(protocol1, protocol2);
	});
});
