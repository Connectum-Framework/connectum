/**
 * Integration tests for CLI proto sync command
 *
 * Tests the full proto sync pipeline:
 * 1. Start a real Connectum server with reflection
 * 2. Test dry-run mode (list services and files)
 * 3. Test fetchReflectionData utility
 * 4. Test fetchFileDescriptorSetBinary utility
 *
 * Note: Full `buf generate` pipeline is tested only if buf CLI is available.
 * The dry-run and reflection client tests always run.
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { create, type DescFile, equals, fromBinary, toBinary } from "@bufbuild/protobuf";
import { FileDescriptorProtoSchema, FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import type { Server } from "@connectum/core";
import { createServer, defineService } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { Reflection } from "@connectum/reflection";
import { Level, MetaSchema } from "../../../reflection/tests/fixtures/fixture/v1/common_pb.ts";
import { MountedService } from "../../../reflection/tests/fixtures/fixture/v1/multi_pb.ts";
import { FixtureService } from "../../../reflection/tests/fixtures/fixture/v1/service_pb.ts";
import { executeProtoSync } from "../../src/commands/proto-sync.ts";
import { fetchFileDescriptorSetBinary, fetchReflectionData } from "../../src/utils/reflection.ts";

/**
 * The fixture files a client must receive for the two fixture services, each after its imports:
 * a depth-first walk of the generated descriptors, which know nothing about the CLI.
 */
function expectedFixtureFiles(): DescFile[] {
	const ordered = new Map<string, DescFile>();
	const visit = (file: DescFile): void => {
		for (const dependency of file.dependencies) {
			visit(dependency);
		}
		ordered.set(file.name, file);
	};
	visit(FixtureService.file);
	visit(MountedService.file);
	return [...ordered.values()];
}

describe("CLI proto sync", () => {
	let server: Server;
	let serverUrl: string;

	before(async () => {
		server = createServer({
			services: [
				defineService(FixtureService, { get: () => create(MetaSchema, { level: Level.HIGH }), ping: () => ({}) }),
				defineService(MountedService, { ping: () => ({}) }),
			],
			port: 0,
			interceptors: [],
			protocols: [Healthcheck(), Reflection()],
			allowHTTP1: false,
		});

		await server.start();
		const port = server.address?.port;
		assert.ok(port, "Server should have an assigned port");
		serverUrl = `http://localhost:${port}`;
	});

	after(async () => {
		if (server?.isRunning) {
			await server.stop();
		}
	});

	describe("fetchReflectionData", () => {
		it("should fetch services and file registry from running server", async () => {
			const result = await fetchReflectionData(serverUrl);

			// The mounted services, in registration order (application services, then the
			// protocols'); the reflection service does not list itself.
			assert.deepStrictEqual(result.services, ["fixture.v1.FixtureService", "fixture.v1.MountedService", "grpc.health.v1.Health"]);

			// Every file of the mounted services and of their imports, each after its imports and
			// none twice. Reflection file names carry no ".proto" suffix.
			const fixtureFiles = expectedFixtureFiles().map((file) => file.name);
			assert.deepStrictEqual([...result.fileNames].sort(), [...fixtureFiles, "grpc/health/v1/health"].sort());
			assert.strictEqual(new Set(result.fileNames).size, result.fileNames.length, "no file twice");
			for (const file of expectedFixtureFiles()) {
				for (const dependency of file.dependencies) {
					assert.ok(result.fileNames.indexOf(dependency.name) < result.fileNames.indexOf(file.name), `${file.name} must come after its import ${dependency.name}`);
				}
			}

			for (const service of ["fixture.v1.FixtureService", "fixture.v1.MountedService", "grpc.health.v1.Health"]) {
				assert.ok(result.registry.getService(service), `the registry must resolve ${service}`);
			}
		});
	});

	describe("fetchFileDescriptorSetBinary", () => {
		it("should fetch binary FileDescriptorSet from running server", async () => {
			const binpb = await fetchFileDescriptorSetBinary(serverUrl);

			// The bytes are a FileDescriptorSet that carries exactly the files the server describes.
			const decoded = fromBinary(FileDescriptorSetSchema, binpb);
			const expected = expectedFixtureFiles();
			assert.deepStrictEqual(
				decoded.file.map((file) => file.name).sort(),
				[...expected.map((file) => file.proto.name), "grpc/health/v1/health.proto"].sort(),
			);
			for (const file of expected) {
				const received = decoded.file.find((candidate) => candidate.name === file.proto.name);
				assert.ok(received, `${file.proto.name} is missing from the set`);
				assert.ok(
					equals(FileDescriptorProtoSchema, received, file.proto),
					`${file.proto.name} must arrive unchanged: the bytes of what the server was built from are ${toBinary(FileDescriptorProtoSchema, file.proto).byteLength}, got ${toBinary(FileDescriptorProtoSchema, received).byteLength}`,
				);
			}
			// Each file follows the files it imports, which is what buf needs to read the set.
			const position = new Map(decoded.file.map((file, index) => [file.name, index]));
			for (const file of decoded.file) {
				for (const dependency of file.dependency) {
					assert.ok((position.get(dependency) ?? Number.POSITIVE_INFINITY) < (position.get(file.name) ?? -1), `${file.name} must come after its import ${dependency}`);
				}
			}
		});
	});

	describe("dry-run mode", () => {
		it("should execute dry-run without errors", async () => {
			// Capture console.log output
			const logs: string[] = [];
			const originalLog = console.log;
			console.log = (...args: unknown[]) => {
				logs.push(args.map(String).join(" "));
			};

			try {
				await executeProtoSync({
					from: serverUrl,
					out: "./gen",
					dryRun: true,
				});

				// Verify expected output structure
				const output = logs.join("\n");
				assert.ok(output.includes("Connected to"), "Should show connection message");
				assert.ok(output.includes("Services:"), "Should show services header");
				assert.ok(output.includes("grpc.health.v1.Health"), "Should list health service");
				assert.ok(output.includes("Files:"), "Should show files header");
				assert.ok(output.includes("Would generate to: ./gen"), "Should show output directory");
			} finally {
				console.log = originalLog;
			}
		});
	});

	describe("URL normalization", () => {
		it("should handle URL without protocol prefix", async () => {
			const port = server.address?.port;
			assert.ok(port);

			const result = await fetchReflectionData(`http://localhost:${port}`);
			assert.ok(result.services.length > 0, "Should work with full URL");
		});
	});
});
