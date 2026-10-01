import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { Reflection } from "../../src/Reflection.ts";
import { file_fixture_v1_service } from "../fixtures/fixture/v1/service_pb.ts";

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
			protocol.setup?.(mockContext as any);
			protocol.register(mockRouter as any);
		});
	});

	// An empty descriptor set would advertise "no services" instead of failing,
	// hiding a server that skipped setup.
	it("should throw when register is called before setup", () => {
		const protocol = Reflection();

		const mockRouter = {
			service: mock.fn(),
			rpc: mock.fn(),
		};

		assert.throws(() => protocol.register(mockRouter as any), /before setup/);
	});

	// Both protocol versions must be mounted: grpcurl and buf curl try v1
	// first, older clients only know v1alpha.
	it("registers the v1 and v1alpha reflection services", () => {
		const protocol = Reflection();

		const serviceFn = mock.fn();
		const mockRouter = {
			service: serviceFn,
			rpc: mock.fn(),
		};

		protocol.setup?.({ registry: [file_fixture_v1_service] });
		protocol.register(mockRouter as any);

		assert.deepStrictEqual(
			serviceFn.mock.calls.map((call) => (call.arguments[0] as { typeName: string }).typeName),
			["grpc.reflection.v1.ServerReflection", "grpc.reflection.v1alpha.ServerReflection"],
		);
	});
});
