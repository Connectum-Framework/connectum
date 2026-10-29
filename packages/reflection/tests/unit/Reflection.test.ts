import assert from "node:assert";
import { describe, it, mock } from "node:test";
import { create } from "@bufbuild/protobuf";
import { ServerReflectionRequestSchema } from "#gen/grpc/reflection/v1/reflection_pb.js";
import { ServerReflectionRequestSchema as V1alphaRequestSchema } from "#gen/grpc/reflection/v1alpha/reflection_pb.js";
import { Reflection } from "../../src/Reflection.ts";
import { file_fixture_v1_service } from "../fixtures/fixture/v1/service_pb.ts";

describe("Reflection", () => {
	it("should return a ProtocolRegistration", () => {
		const protocol = Reflection();

		assert.strictEqual(protocol.name, "reflection");
		assert.strictEqual(typeof protocol.register, "function");
	});

	// The protocol holds the descriptors of the server it was set up for. These
	// checks drive the registered handlers directly: what each handler lists
	// after setup, never the shape of the registration object.
	describe("what the registered handlers list", () => {
		type Impl = { serverReflectionInfo(requests: AsyncIterable<unknown>, context: { signal: AbortSignal }): AsyncIterable<{ messageResponse: { case?: string; value?: any } }> };

		const SERVICES = ["grpc.reflection.v1.ServerReflection", "grpc.reflection.v1alpha.ServerReflection"] as const;

		function contextOf(...typeNames: string[]) {
			return { registry: [], services: typeNames.map((typeName) => ({ typeName })) } as never;
		}

		/** Registers the protocol on a fresh router and returns the handler of each reflection service. */
		function mount(protocol: ReturnType<typeof Reflection>): Map<string, Impl> {
			const impls = new Map<string, Impl>();
			protocol.register({
				service: (desc: { typeName: string }, impl: Impl) => {
					impls.set(desc.typeName, impl);
				},
			} as never);
			return impls;
		}

		async function listed(impls: Map<string, Impl>, typeName: (typeof SERVICES)[number]): Promise<string[]> {
			const impl = impls.get(typeName);
			assert.ok(impl, `${typeName} must be mounted`);
			const request = typeName.includes("v1alpha")
				? create(V1alphaRequestSchema, { messageRequest: { case: "listServices", value: "" } })
				: create(ServerReflectionRequestSchema, { messageRequest: { case: "listServices", value: "" } });
			async function* requests() {
				yield request;
			}
			for await (const response of impl.serverReflectionInfo(requests(), { signal: new AbortController().signal })) {
				assert.strictEqual(response.messageResponse.case, "listServicesResponse");
				return response.messageResponse.value.service.map((s: { name: string }) => s.name);
			}
			throw new Error("the stream ended without a response");
		}

		// The protocol returns the services "in registration order"; an order that merely
		// happens to be alphabetical in the other tests would hide a sorted listing.
		for (const typeName of SERVICES) {
			it(`${typeName} lists the services in registration order, not alphabetically`, async () => {
				const protocol = Reflection();
				protocol.setup?.(contextOf("z.Last", "a.First", "m.Middle"));

				assert.deepStrictEqual(await listed(mount(protocol), typeName), ["z.Last", "a.First", "m.Middle"]);
			});
		}

		it("keeps each Reflection() instance's own listing when another server is set up in between", async () => {
			const first = Reflection();
			const second = Reflection();
			first.setup?.(contextOf("first.v1.Service"));
			second.setup?.(contextOf("second.v1.Service"));

			// A router built after the other instance's setup (an in-process transport) still gets its own instance's listing.
			assert.deepStrictEqual(await listed(mount(first), SERVICES[0]), ["first.v1.Service"]);
			assert.deepStrictEqual(await listed(mount(second), SERVICES[0]), ["second.v1.Service"]);
		});

		// When route materialization fails, the server calls setup again; the listing must
		// come from that last attempt, not from the abandoned one.
		it("lists what the latest setup saw when setup runs again", async () => {
			const protocol = Reflection();
			protocol.setup?.(contextOf("stale.v1.Service"));
			protocol.setup?.(contextOf("fresh.v1.Service"));

			assert.deepStrictEqual(await listed(mount(protocol), SERVICES[0]), ["fresh.v1.Service"]);
		});
	});

	// A server with nothing mounted before reflection still serves both protocol
	// versions; the answers for the empty case (empty list, NOT_FOUND) are
	// checked over the network in the integration tests.
	it("should still mount both reflection services when the registry is empty", () => {
		const protocol = Reflection();

		const serviceFn = mock.fn();
		const mockRouter = {
			service: serviceFn,
			rpc: mock.fn(),
		};
		const mockContext = {
			registry: [],
			services: [],
		};

		protocol.setup?.(mockContext as any);
		protocol.register(mockRouter as any);

		assert.deepStrictEqual(
			serviceFn.mock.calls.map((call) => (call.arguments[0] as { typeName: string }).typeName),
			["grpc.reflection.v1.ServerReflection", "grpc.reflection.v1alpha.ServerReflection"],
		);
	});

	// An empty descriptor set would advertise "no services" instead of failing,
	// hiding a server that skipped setup. Nothing may be mounted by the failed call.
	it("should throw when register is called before setup, mounting nothing", () => {
		const protocol = Reflection();

		const serviceFn = mock.fn();
		const mockRouter = {
			service: serviceFn,
			rpc: mock.fn(),
		};

		assert.throws(() => protocol.register(mockRouter as any), (error: unknown) => error instanceof Error && /before setup/.test(error.message));
		assert.strictEqual(serviceFn.mock.calls.length, 0);
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

		protocol.setup?.({ registry: [file_fixture_v1_service], services: file_fixture_v1_service.services });
		protocol.register(mockRouter as any);

		assert.deepStrictEqual(
			serviceFn.mock.calls.map((call) => (call.arguments[0] as { typeName: string }).typeName),
			["grpc.reflection.v1.ServerReflection", "grpc.reflection.v1alpha.ServerReflection"],
		);
	});
});
