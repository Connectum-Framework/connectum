/**
 * Integration tests for gRPC Server Reflection
 *
 * Tests the full reflection flow using the new protocols API:
 * 1. Start a real server with @connectum/healthcheck and @connectum/reflection
 * 2. Connect via ServerReflectionClient
 * 3. Verify listServices, getFileContainingSymbol, buildFileRegistry
 * 4. Stop the server
 *
 * Uses @lambdalisue/connectrpc-grpcreflect client (same library as server-side).
 * Transport: createGrpcTransport (HTTP/2, required for bidirectional streaming).
 */

import assert from "node:assert";
import { after, before, describe, it } from "node:test";
import { createGrpcTransport } from "@connectrpc/connect-node";
import { createServer } from "@connectum/core";
import type { Server } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { ServerReflectionClient } from "@lambdalisue/connectrpc-grpcreflect/client";
import { Reflection } from "../../src/Reflection.ts";

describe("Reflection Integration", () => {
	let server: Server;
	let serverUrl: string;

	before(async () => {
		server = createServer({
			services: [],
			port: 0,
			protocols: [Healthcheck(), Reflection()],
			interceptors: [],
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

	it("should list services via reflection", async () => {
		const transport = createGrpcTransport({ baseUrl: serverUrl });

		const client = new ServerReflectionClient(transport);
		try {
			const services = await client.listServices();

			assert.ok(Array.isArray(services), "listServices should return an array");
			assert.ok(services.length > 0, "Should have at least one service");

			// Health service should be registered (via Healthcheck protocol)
			assert.ok(
				services.includes("grpc.health.v1.Health"),
				`Expected grpc.health.v1.Health in services, got: ${JSON.stringify(services)}`,
			);
		} finally {
			await client.close();
		}
	});

	it("should get file descriptor for health service symbol", async () => {
		const transport = createGrpcTransport({ baseUrl: serverUrl });

		const client = new ServerReflectionClient(transport);
		try {
			const fileDescriptor = await client.getFileContainingSymbol("grpc.health.v1.Health");

			assert.ok(fileDescriptor, "Should return a file descriptor");
			assert.ok(fileDescriptor.name, "File descriptor should have a name");
			assert.ok(
				fileDescriptor.name.includes("health"),
				`File name should contain 'health', got: ${fileDescriptor.name}`,
			);
		} finally {
			await client.close();
		}
	});

	it("should build full file registry via reflection", async () => {
		const transport = createGrpcTransport({ baseUrl: serverUrl });

		const client = new ServerReflectionClient(transport);
		try {
			const registry = await client.buildFileRegistry();

			assert.ok(registry, "Should return a FileRegistry");

			// Registry should contain files
			const files = [...registry.files];
			assert.ok(files.length > 0, `Expected at least one file in registry, got ${files.length}`);

			// Should contain health proto file
			const healthFile = files.find((f) => f.name.includes("health"));
			assert.ok(healthFile, `Expected health proto file in registry, files: ${files.map((f) => f.name).join(", ")}`);
		} finally {
			await client.close();
		}
	});

	it("should get service descriptor with methods", async () => {
		const transport = createGrpcTransport({ baseUrl: serverUrl });

		const client = new ServerReflectionClient(transport);
		try {
			const serviceDesc = await client.getServiceDescriptor("grpc.health.v1.Health");

			assert.ok(serviceDesc, "Should return a service descriptor");
			assert.strictEqual(serviceDesc.fullName, "grpc.health.v1.Health");
			assert.ok(serviceDesc.methods.length > 0, "Health service should have methods");

			// Check, List and Watch methods expected
			const methodNames = serviceDesc.methods.map((m) => m.name);
			assert.ok(methodNames.includes("Check"), `Expected Check method, got: ${JSON.stringify(methodNames)}`);
		} finally {
			await client.close();
		}
	});
});
