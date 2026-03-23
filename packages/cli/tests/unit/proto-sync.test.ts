/**
 * Unit tests for proto-sync command
 *
 * Tests URL normalization, dry-run mode, full sync pipeline,
 * error handling, and command definition without requiring
 * a running gRPC server.
 *
 * Uses mock.module() to replace reflection utilities and child_process.
 */

import assert from "node:assert";
import { beforeEach, describe, it, mock } from "node:test";

// ---------------------------------------------------------------------------
// Module-level mocks (must be registered BEFORE importing the module under test)
// ---------------------------------------------------------------------------

const mockFetchReflectionData = mock.fn(async (_url: string) => ({
	services: ["test.Service", "grpc.health.v1.Health"],
	registry: {} as any,
	fileNames: ["test.proto", "health.proto"],
}));

const mockFetchFileDescriptorSetBinary = mock.fn(
	async (_url: string) => new Uint8Array([0x0a, 0x01, 0x02]),
);

mock.module("../../src/utils/reflection.ts", {
	namedExports: {
		fetchReflectionData: mockFetchReflectionData,
		fetchFileDescriptorSetBinary: mockFetchFileDescriptorSetBinary,
	},
});

const mockExecSync = mock.fn((_command: string, _options?: any) => Buffer.from(""));

mock.module("node:child_process", {
	namedExports: {
		execSync: mockExecSync,
	},
});

// We also need to mock fs operations used by executeFullSync
const mockMkdtempSync = mock.fn((_prefix: string) => "/fake-tmp/connectum-proto-sync-XXXXXX");
const mockRmSync = mock.fn((_path: string, _options?: any) => undefined);
const mockWriteFileSync = mock.fn((_path: string, _data: any) => undefined);

mock.module("node:fs", {
	namedExports: {
		mkdtempSync: mockMkdtempSync,
		rmSync: mockRmSync,
		writeFileSync: mockWriteFileSync,
	},
});

mock.module("node:os", {
	namedExports: {
		tmpdir: () => "/fake-tmp",
	},
});

// Import AFTER mock registration
const { executeProtoSync, protoSyncCommand } = await import("../../src/commands/proto-sync.ts");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Capture console.log output during a callback */
async function captureConsoleLog(fn: () => Promise<void>): Promise<string[]> {
	const logs: string[] = [];
	const originalLog = console.log;
	console.log = (...args: unknown[]) => {
		logs.push(args.map(String).join(" "));
	};
	try {
		await fn();
	} finally {
		console.log = originalLog;
	}
	return logs;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("proto-sync unit tests", () => {
	beforeEach(() => {
		mockFetchReflectionData.mock.resetCalls();
		mockFetchFileDescriptorSetBinary.mock.resetCalls();
		mockExecSync.mock.resetCalls();
		mockMkdtempSync.mock.resetCalls();
		mockRmSync.mock.resetCalls();
		mockWriteFileSync.mock.resetCalls();
	});

	// -----------------------------------------------------------------------
	// URL normalization
	// -----------------------------------------------------------------------

	describe("URL normalization", () => {
		it("should prepend http:// to bare host", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "localhost:5000",
					out: "./gen",
					dryRun: true,
				});
			});

			assert.strictEqual(mockFetchReflectionData.mock.calls.length, 1);
			assert.strictEqual(
				mockFetchReflectionData.mock.calls[0]!.arguments[0],
				"http://localhost:5000",
			);
		});

		it("should preserve existing http:// prefix", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
					dryRun: true,
				});
			});

			assert.strictEqual(mockFetchReflectionData.mock.calls.length, 1);
			assert.strictEqual(
				mockFetchReflectionData.mock.calls[0]!.arguments[0],
				"http://localhost:5000",
			);
		});

		it("should preserve existing https:// prefix", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "https://secure.example.com:443",
					out: "./gen",
					dryRun: true,
				});
			});

			assert.strictEqual(mockFetchReflectionData.mock.calls.length, 1);
			assert.strictEqual(
				mockFetchReflectionData.mock.calls[0]!.arguments[0],
				"https://secure.example.com:443",
			);
		});
	});

	// -----------------------------------------------------------------------
	// executeDryRun (via executeProtoSync with dryRun: true)
	// -----------------------------------------------------------------------

	describe("executeDryRun", () => {
		it("should call fetchReflectionData with normalized URL", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "myserver:8080",
					out: "./out",
					dryRun: true,
				});
			});

			assert.strictEqual(mockFetchReflectionData.mock.calls.length, 1);
			assert.strictEqual(
				mockFetchReflectionData.mock.calls[0]!.arguments[0],
				"http://myserver:8080",
			);
		});

		it("should log service names and file names to console", async () => {
			const logs = await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
					dryRun: true,
				});
			});

			const output = logs.join("\n");

			assert.ok(output.includes("Connecting to http://localhost:5000"), "Should show connecting message");
			assert.ok(output.includes("Connected to http://localhost:5000"), "Should show connected message");
			assert.ok(output.includes("Services:"), "Should show services header");
			assert.ok(output.includes("test.Service"), "Should list test.Service");
			assert.ok(output.includes("grpc.health.v1.Health"), "Should list health service");
			assert.ok(output.includes("Files:"), "Should show files header");
			assert.ok(output.includes("test.proto"), "Should list test.proto");
			assert.ok(output.includes("health.proto"), "Should list health.proto");
			assert.ok(output.includes("Would generate to: ./gen"), "Should show output directory");
		});

		it("should NOT call fetchFileDescriptorSetBinary in dry-run mode", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
					dryRun: true,
				});
			});

			assert.strictEqual(
				mockFetchFileDescriptorSetBinary.mock.calls.length,
				0,
				"fetchFileDescriptorSetBinary should not be called in dry-run mode",
			);
		});

		it("should NOT call execSync in dry-run mode", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
					dryRun: true,
				});
			});

			assert.strictEqual(
				mockExecSync.mock.calls.length,
				0,
				"execSync should not be called in dry-run mode",
			);
		});
	});

	// -----------------------------------------------------------------------
	// executeFullSync (via executeProtoSync with dryRun: false/undefined)
	// -----------------------------------------------------------------------

	describe("executeFullSync", () => {
		it("should call fetchFileDescriptorSetBinary with normalized URL", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "localhost:5000",
					out: "./gen",
				});
			});

			assert.strictEqual(mockFetchFileDescriptorSetBinary.mock.calls.length, 1);
			assert.strictEqual(
				mockFetchFileDescriptorSetBinary.mock.calls[0]!.arguments[0],
				"http://localhost:5000",
			);
		});

		it("should write binary descriptor to temp file", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
				});
			});

			assert.strictEqual(mockWriteFileSync.mock.calls.length, 1);

			const [path, data] = mockWriteFileSync.mock.calls[0]!.arguments;
			assert.ok(typeof path === "string", "Path should be a string");
			assert.ok(path.includes("descriptors.binpb"), "Path should include descriptors.binpb");
			assert.ok(data instanceof Uint8Array, "Data should be Uint8Array");
		});

		it("should run buf generate without --template when template is not specified", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
				});
			});

			assert.strictEqual(mockExecSync.mock.calls.length, 1);

			const command = mockExecSync.mock.calls[0]!.arguments[0] as string;
			assert.ok(command.startsWith("buf generate"), "Command should start with 'buf generate'");
			assert.ok(command.includes("--output ./gen"), "Command should include --output flag");
			assert.ok(!command.includes("--template"), "Command should NOT include --template when not specified");
		});

		it("should include --template flag when template is specified", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
					template: "./custom-buf.gen.yaml",
				});
			});

			assert.strictEqual(mockExecSync.mock.calls.length, 1);

			const command = mockExecSync.mock.calls[0]!.arguments[0] as string;
			assert.ok(
				command.includes("--template ./custom-buf.gen.yaml"),
				`Command should include --template flag, got: ${command}`,
			);
		});

		it("should use stdio: inherit for buf generate", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
				});
			});

			const options = mockExecSync.mock.calls[0]!.arguments[1] as Record<string, unknown>;
			assert.strictEqual(options?.stdio, "inherit", "Should pass stdio: inherit");
		});

		it("should clean up temp directory after successful sync", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
				});
			});

			assert.strictEqual(mockRmSync.mock.calls.length, 1, "rmSync should be called for cleanup");

			const [cleanupPath, cleanupOptions] = mockRmSync.mock.calls[0]!.arguments;
			assert.ok(typeof cleanupPath === "string", "Cleanup path should be a string");
			assert.strictEqual(cleanupOptions?.recursive, true, "Should use recursive: true");
			assert.strictEqual(cleanupOptions?.force, true, "Should use force: true");
		});

		it("should clean up temp directory even when buf generate fails", async () => {
			mockExecSync.mock.mockImplementationOnce(() => {
				throw new Error("buf generate failed");
			});

			await assert.rejects(
				async () => {
					await captureConsoleLog(async () => {
						await executeProtoSync({
							from: "http://localhost:5000",
							out: "./gen",
						});
					});
				},
				{ message: "buf generate failed" },
			);

			assert.strictEqual(
				mockRmSync.mock.calls.length,
				1,
				"rmSync should still be called for cleanup after failure",
			);
		});

		it("should log fetched bytes count", async () => {
			const logs = await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
				});
			});

			const output = logs.join("\n");
			assert.ok(
				output.includes("Fetched 3 bytes of descriptors"),
				`Should log byte count, got: ${output}`,
			);
		});

		it("should log the buf generate command", async () => {
			const logs = await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
				});
			});

			const output = logs.join("\n");
			assert.ok(
				output.includes("Running: buf generate"),
				`Should log the running command, got: ${output}`,
			);
		});

		it("should log success message after sync", async () => {
			const logs = await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
				});
			});

			const output = logs.join("\n");
			assert.ok(
				output.includes("Proto types synced to ./gen"),
				`Should log success, got: ${output}`,
			);
		});
	});

	// -----------------------------------------------------------------------
	// Negative / error scenarios
	// -----------------------------------------------------------------------

	describe("error scenarios", () => {
		it("should propagate connection errors from fetchReflectionData", async () => {
			mockFetchReflectionData.mock.mockImplementationOnce(async () => {
				const error = new Error("connect ECONNREFUSED 127.0.0.1:5000");
				(error as any).code = "ECONNREFUSED";
				throw error;
			});

			await assert.rejects(
				async () => {
					await captureConsoleLog(async () => {
						await executeProtoSync({
							from: "http://localhost:5000",
							out: "./gen",
							dryRun: true,
						});
					});
				},
				{ message: /ECONNREFUSED/ },
			);
		});

		it("should propagate connection errors from fetchFileDescriptorSetBinary", async () => {
			mockFetchFileDescriptorSetBinary.mock.mockImplementationOnce(async () => {
				const error = new Error("connect ECONNREFUSED 127.0.0.1:5000");
				(error as any).code = "ECONNREFUSED";
				throw error;
			});

			await assert.rejects(
				async () => {
					await captureConsoleLog(async () => {
						await executeProtoSync({
							from: "http://localhost:5000",
							out: "./gen",
						});
					});
				},
				{ message: /ECONNREFUSED/ },
			);
		});

		it("should propagate buf CLI ENOENT error when buf is not installed", async () => {
			mockExecSync.mock.mockImplementationOnce(() => {
				const error = new Error("spawnSync buf ENOENT") as NodeJS.ErrnoException;
				error.code = "ENOENT";
				throw error;
			});

			await assert.rejects(
				async () => {
					await captureConsoleLog(async () => {
						await executeProtoSync({
							from: "http://localhost:5000",
							out: "./gen",
						});
					});
				},
				(err: unknown) => {
					assert.ok(err instanceof Error);
					assert.ok(
						err.message.includes("ENOENT"),
						`Expected ENOENT in message, got: ${err.message}`,
					);
					return true;
				},
			);
		});

		it("should propagate non-zero exit code from buf generate", async () => {
			mockExecSync.mock.mockImplementationOnce(() => {
				const error = new Error("Command failed: buf generate") as any;
				error.status = 1;
				error.stderr = Buffer.from("unknown flag --invalid");
				throw error;
			});

			await assert.rejects(
				async () => {
					await captureConsoleLog(async () => {
						await executeProtoSync({
							from: "http://localhost:5000",
							out: "./gen",
						});
					});
				},
				{ message: /Command failed/ },
			);
		});
	});

	// -----------------------------------------------------------------------
	// Shell injection / template safety
	// -----------------------------------------------------------------------

	describe("template parameter handling", () => {
		it("should pass template value directly to the command string", async () => {
			// NOTE: The current implementation does NOT sanitize the template value.
			// This test documents the behavior for awareness.
			// In a real attack, the template would be a user-provided CLI arg,
			// and citty parses it as a string flag value.
			const maliciousTemplate = '"; rm -rf / #';

			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
					template: maliciousTemplate,
				});
			});

			const command = mockExecSync.mock.calls[0]!.arguments[0] as string;

			// Document that the template IS included unsanitized in the command
			// This is a known limitation - the template value from citty CLI args
			// is concatenated into the shell command without escaping.
			assert.ok(
				command.includes(maliciousTemplate),
				"Template value is passed as-is to the command string (no shell escaping)",
			);
		});

		it("should handle template with spaces in the path", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
					template: "./my templates/buf.gen.yaml",
				});
			});

			const command = mockExecSync.mock.calls[0]!.arguments[0] as string;
			assert.ok(
				command.includes("--template ./my templates/buf.gen.yaml"),
				`Template with spaces should be included, got: ${command}`,
			);
		});
	});

	// -----------------------------------------------------------------------
	// protoSyncCommand definition
	// -----------------------------------------------------------------------

	describe("protoSyncCommand", () => {
		it("should have name 'sync'", () => {
			const meta = protoSyncCommand.meta as { name?: string; description?: string } | undefined;
			assert.strictEqual(meta?.name, "sync");
		});

		it("should have a description", () => {
			const meta = protoSyncCommand.meta as { name?: string; description?: string } | undefined;
			assert.ok(
				typeof meta?.description === "string",
				"Should have a description",
			);
			assert.ok(
				meta!.description!.length > 0,
				"Description should not be empty",
			);
		});

		it("should define 'from' as a required string argument", () => {
			const args = protoSyncCommand.args as Record<string, any>;
			assert.ok(args.from, "Should have 'from' arg");
			assert.strictEqual(args.from.type, "string");
			assert.strictEqual(args.from.required, true);
		});

		it("should define 'out' as a required string argument", () => {
			const args = protoSyncCommand.args as Record<string, any>;
			assert.ok(args.out, "Should have 'out' arg");
			assert.strictEqual(args.out.type, "string");
			assert.strictEqual(args.out.required, true);
		});

		it("should define 'template' as an optional string argument", () => {
			const args = protoSyncCommand.args as Record<string, any>;
			assert.ok(args.template, "Should have 'template' arg");
			assert.strictEqual(args.template.type, "string");
			assert.strictEqual(args.template.required, undefined, "template should not be required");
		});

		it("should define 'dry-run' as a boolean with default false", () => {
			const args = protoSyncCommand.args as Record<string, any>;
			assert.ok(args["dry-run"], "Should have 'dry-run' arg");
			assert.strictEqual(args["dry-run"].type, "boolean");
			assert.strictEqual(args["dry-run"].default, false);
		});

		it("should have a run function", () => {
			assert.strictEqual(typeof protoSyncCommand.run, "function");
		});
	});

	// -----------------------------------------------------------------------
	// dryRun routing
	// -----------------------------------------------------------------------

	describe("dryRun routing", () => {
		it("should route to dry-run when dryRun is true", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
					dryRun: true,
				});
			});

			assert.strictEqual(mockFetchReflectionData.mock.calls.length, 1, "Should call fetchReflectionData");
			assert.strictEqual(
				mockFetchFileDescriptorSetBinary.mock.calls.length,
				0,
				"Should NOT call fetchFileDescriptorSetBinary",
			);
			assert.strictEqual(mockExecSync.mock.calls.length, 0, "Should NOT call execSync");
		});

		it("should route to full sync when dryRun is false", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
					dryRun: false,
				});
			});

			assert.strictEqual(
				mockFetchReflectionData.mock.calls.length,
				0,
				"Should NOT call fetchReflectionData",
			);
			assert.strictEqual(
				mockFetchFileDescriptorSetBinary.mock.calls.length,
				1,
				"Should call fetchFileDescriptorSetBinary",
			);
			assert.strictEqual(mockExecSync.mock.calls.length, 1, "Should call execSync");
		});

		it("should route to full sync when dryRun is undefined", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
				});
			});

			assert.strictEqual(
				mockFetchReflectionData.mock.calls.length,
				0,
				"Should NOT call fetchReflectionData when dryRun is undefined",
			);
			assert.strictEqual(
				mockFetchFileDescriptorSetBinary.mock.calls.length,
				1,
				"Should call fetchFileDescriptorSetBinary when dryRun is undefined",
			);
		});
	});
});
