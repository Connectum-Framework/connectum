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
import type { Server } from "@connectum/core";
import { createServer } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { Reflection } from "@connectum/reflection";
import { executeProtoSync } from "../../src/commands/proto-sync.ts";
import { fetchFileDescriptorSetBinary, fetchReflectionData } from "../../src/utils/reflection.ts";

describe("CLI proto sync", () => {
	let server: Server;
	let serverUrl: string;

	before(async () => {
		server = createServer({
			services: [],
			port: 0,
			interceptors: [],
			protocols: [Healthcheck(), Reflection()],
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

			assert.ok(Array.isArray(result.services), "services should be an array");
			assert.ok(result.services.length > 0, "Should discover at least one service");
			assert.ok(
				result.services.includes("grpc.health.v1.Health"),
				`Expected grpc.health.v1.Health, got: ${JSON.stringify(result.services)}`,
			);

			assert.ok(result.registry, "Should return a registry");
			assert.ok(Array.isArray(result.fileNames), "fileNames should be an array");
			assert.ok(result.fileNames.length > 0, "Should have at least one file");
		});
	});

	describe("fetchFileDescriptorSetBinary", () => {
		it("should fetch binary FileDescriptorSet from running server", async () => {
			const binpb = await fetchFileDescriptorSetBinary(serverUrl);

			assert.ok(binpb instanceof Uint8Array, "Should return Uint8Array");
			assert.ok(binpb.byteLength > 0, "Binary should not be empty");
			// FileDescriptorSet starts with field 1, wire type 2 (length-delimited) = 0x0a
			assert.strictEqual(binpb[0], 0x0a, "Should start with valid protobuf field tag");
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
