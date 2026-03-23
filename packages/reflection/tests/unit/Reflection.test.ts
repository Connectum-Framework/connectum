import assert from "node:assert";
import { describe, it, mock } from "node:test";
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

	it("should register without throwing when registry is empty", () => {
		const protocol = Reflection();

		const mockRouter = {
			service: mock.fn(),
			rpc: mock.fn(),
		};
		const mockContext = {
			registry: [],
		};

		assert.doesNotThrow(() => {
			protocol.register(mockRouter as any, mockContext as any);
		});
	});

	it("should call router.service when registering with service files", () => {
		const protocol = Reflection();

		const serviceFn = mock.fn();
		const mockRouter = {
			service: serviceFn,
			rpc: mock.fn(),
		};

		const mockFile = {
			name: "test.proto",
			proto: { name: "test.proto" },
			dependencies: [],
		};
		const mockContext = {
			registry: [mockFile],
		};

		protocol.register(mockRouter as any, mockContext as any);

		// registerServerReflectionFromFileDescriptorSet registers v1 + v1alpha
		assert.ok(
			serviceFn.mock.calls.length >= 1,
			`Expected router.service to be called at least once, got ${serviceFn.mock.calls.length} calls`,
		);
	});
});
