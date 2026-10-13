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
		DEFAULT_REFLECTION_TIMEOUT_MS: 10_000,
		MAX_REFLECTION_TIMEOUT_MS: 2_147_483_647,
		isValidReflectionTimeout: (v: number) => Number.isInteger(v) && v >= 1 && v <= 2_147_483_647,
	},
});

const mockExecFileSync = mock.fn((_file: string, _args?: string[], _options?: any) => Buffer.from(""));

mock.module("node:child_process", {
	namedExports: {
		execFileSync: mockExecFileSync,
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
const { executeProtoSync, parseTimeoutOption, protoSyncCommand } = await import("../../src/commands/proto-sync.ts");

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
		mockExecFileSync.mock.resetCalls();
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

		// The guide describes --dry-run as "Connect, list the services and files, generate nothing".
		// So the observable contract is that every service name and every file name the server
		// reported reaches the user; the wording and layout of the surrounding lines is not
		// documented and is deliberately not pinned here.
		it("lists every reported service and file name to the user", async () => {
			const logs = await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
					dryRun: true,
				});
			});

			const reported = await mockFetchReflectionData.mock.calls[0]!.result!;
			assert.ok(reported.services.length > 0 && reported.fileNames.length > 0, "fixture must report something to list");
			for (const name of [...reported.services, ...reported.fileNames]) {
				assert.ok(
					logs.some((line) => line.includes(name)),
					`"${name}" must be shown to the user, got: ${logs.join(" | ")}`,
				);
			}
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

		it("should NOT call execFileSync in dry-run mode", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
					dryRun: true,
				});
			});

			assert.strictEqual(
				mockExecFileSync.mock.calls.length,
				0,
				"execFileSync should not be called in dry-run mode",
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

			assert.strictEqual(mockExecFileSync.mock.calls.length, 1);

			const [file, args] = mockExecFileSync.mock.calls[0]!.arguments;
			assert.strictEqual(file, "buf", "Should call 'buf' executable");
			assert.ok(Array.isArray(args), "Args should be an array");
			assert.strictEqual(args[0], "generate", "First arg should be 'generate'");
			assert.ok(args.includes("--output"), "Args should include --output flag");
			assert.strictEqual(args[args.indexOf("--output") + 1], "./gen", "--output value should be './gen'");
			assert.ok(!args.includes("--template"), "Args should NOT include --template when not specified");
		});

		it("should include --template flag when template is specified", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
					template: "./custom-buf.gen.yaml",
				});
			});

			assert.strictEqual(mockExecFileSync.mock.calls.length, 1);

			const [, args] = mockExecFileSync.mock.calls[0]!.arguments;
			assert.ok(Array.isArray(args), "Args should be an array");
			assert.ok(args.includes("--template"), "Args should include --template flag");
			assert.strictEqual(
				args[args.indexOf("--template") + 1],
				"./custom-buf.gen.yaml",
				"--template value should be './custom-buf.gen.yaml'",
			);
		});

		// No documented source for the exact spawn options. The guide only says that generation needs
		// `buf` and its plugins installed, which makes buf's own diagnostics (a missing plugin, a bad
		// template) the only explanation of a failed run. The behavior worth pinning is therefore
		// that buf's stdout and stderr are not swallowed; `inherit`, a three-element array of
		// `inherit` or the parent's own descriptors all satisfy it.
		it("does not swallow buf output: stdout and stderr stay connected to the user's terminal", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
				});
			});

			const options = mockExecFileSync.mock.calls[0]!.arguments[2] as { stdio?: unknown } | undefined;
			const stdio = options?.stdio;
			const forwarded = (stream: unknown, fd: number) => stream === "inherit" || stream === fd;
			const reachesUser = stdio === "inherit" || (Array.isArray(stdio) && forwarded(stdio[1], 1) && forwarded(stdio[2], 2));
			assert.ok(reachesUser, `buf stdout and stderr must be forwarded, got stdio: ${JSON.stringify(stdio)}`);
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
			mockExecFileSync.mock.mockImplementationOnce(() => {
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

		// The progress lines of a full sync are not described by the guide or the specs, so their
		// wording is a Connectum decision and is not pinned. What is pinned is the information each
		// line carries, checked against values that the test itself controls.

		it("Connectum decision (wording undocumented): progress output reports the size of the fetched descriptor set", async () => {
			// A size that cannot occur by accident in a URL, a path or a flag in the output.
			const descriptorSize = 4219;
			mockFetchFileDescriptorSetBinary.mock.mockImplementationOnce(async () => new Uint8Array(descriptorSize));

			const logs = await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
				});
			});

			assert.ok(
				logs.some((line) => line.includes(String(descriptorSize))),
				`the byte count must be shown, got: ${logs.join(" | ")}`,
			);
		});

		it("Connectum decision (wording undocumented): progress output shows the exact buf arguments that are executed", async () => {
			const logs = await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
					template: "./custom-buf.gen.yaml",
				});
			});

			const [file, args] = mockExecFileSync.mock.calls[0]!.arguments;
			assert.ok(Array.isArray(args) && args.length > 0, "fixture must pass arguments to buf");
			// One single line must contain the executable followed by every argument actually passed,
			// in the order they were passed (swapped values would show a different command), so
			// what the user reads is what ran.
			assert.ok(
				logs.some((line) => line.includes(`${String(file)} ${args.join(" ")}`)),
				`a line must show "${file} ${args.join(" ")}", got: ${logs.join(" | ")}`,
			);
		});

		it("Connectum decision (wording undocumented): the last line names the output directory and appears only after buf succeeded", async () => {
			const logs = await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
				});
			});
			assert.ok(logs[logs.length - 1]!.includes("./gen"), `the final line must name the output directory, got: ${logs.join(" | ")}`);

			// When buf fails the user must not be told that anything was synced: the last line
			// printed is then the one that announced the command, which carries the same
			// arguments and names the output directory too.
			mockExecFileSync.mock.mockImplementationOnce(() => {
				throw new Error("buf generate failed");
			});
			const failedLogs: string[] = [];
			const originalLog = console.log;
			console.log = (...args: unknown[]) => {
				failedLogs.push(args.map(String).join(" "));
			};
			try {
				await assert.rejects(executeProtoSync({ from: "http://localhost:5000", out: "./gen" }), { message: "buf generate failed" });
			} finally {
				console.log = originalLog;
			}
			assert.strictEqual(
				failedLogs.length,
				logs.length - 1,
				`a failed run must print exactly one line less than a successful one, got: ${failedLogs.join(" | ")}`,
			);
			assert.deepStrictEqual(failedLogs, logs.slice(0, -1));
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
			mockExecFileSync.mock.mockImplementationOnce(() => {
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
			mockExecFileSync.mock.mockImplementationOnce(() => {
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
		it("should safely pass malicious template as array argument (no shell injection)", async () => {
			// With execFileSync, arguments are passed as array elements,
			// not interpolated into a shell command string.
			// Shell metacharacters in template value are harmless.
			const maliciousTemplate = '"; rm -rf / #';

			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
					template: maliciousTemplate,
				});
			});

			const [file, args] = mockExecFileSync.mock.calls[0]!.arguments;
			assert.strictEqual(file, "buf", "Should call 'buf' executable");
			assert.ok(Array.isArray(args), "Args should be an array");

			// The malicious string is safely contained as a single array element
			const templateIdx = args.indexOf("--template");
			assert.ok(templateIdx >= 0, "Should have --template flag");
			assert.strictEqual(
				args[templateIdx + 1],
				maliciousTemplate,
				"Template value is safely passed as a separate argument (no shell interpolation)",
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

			const [, args] = mockExecFileSync.mock.calls[0]!.arguments;
			assert.ok(Array.isArray(args), "Args should be an array");

			const templateIdx = args.indexOf("--template");
			assert.ok(templateIdx >= 0, "Should have --template flag");
			assert.strictEqual(
				args[templateIdx + 1],
				"./my templates/buf.gen.yaml",
				"Template with spaces should be a single array element",
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
			assert.strictEqual(mockExecFileSync.mock.calls.length, 0, "Should NOT call execFileSync");
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
			assert.strictEqual(mockExecFileSync.mock.calls.length, 1, "Should call execFileSync");
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

describe("parseTimeoutOption", () => {
	it("accepts a plain positive integer and passes an absent value through", () => {
		assert.equal(parseTimeoutOption("500"), 500);
		assert.equal(parseTimeoutOption(undefined), undefined);
	});

	// The specification names exactly these as rejected: zero, a negative number, a fractional
	// number and a non-number (plus an empty value, which is no number either).
	for (const bad of ["0", "-5", "1.5", "abc", "10s", ""]) {
		it(`rejects ${JSON.stringify(bad)}`, () => {
			assert.throws(() => parseTimeoutOption(bad), /--timeout must be a positive integer/);
		});
	}

	// Connectum decision, the specification is silent: it requires "an integer from 1 to
	// 2147483647" and does not say whether the spelling "007" of the integer 7 counts. The
	// implementation accepts only the canonical decimal spelling, so a padded value is refused
	// instead of being read as 7 (or, by a parser that treats a leading zero as octal, as another number).
	it("Connectum decision (undocumented): rejects a leading-zero spelling \"007\" instead of reading it as 7", () => {
		assert.throws(() => parseTimeoutOption("007"), /--timeout must be a positive integer/);
	});

	it("leaves the upper bound to executeProtoSync, which refuses it before connecting", async () => {
		assert.equal(parseTimeoutOption("2147483648"), 2147483648);
		await assert.rejects(
			executeProtoSync({ from: "localhost:5000", out: "gen", timeoutMs: 2147483648 }),
			/--timeout must be a positive integer/,
		);
	});
});
