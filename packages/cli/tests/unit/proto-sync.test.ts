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
import { CliError } from "../../src/utils/cliError.ts";

// ---------------------------------------------------------------------------
// Module-level mocks (must be registered BEFORE importing the module under test)
// ---------------------------------------------------------------------------

const mockFetchReflectionData = mock.fn(async (_url: string, _options?: { timeoutMs?: number }) => ({
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
		MAX_REFLECTION_TIMEOUT_MS: 99_999_999,
		isValidReflectionTimeout: (v: number) => Number.isInteger(v) && v >= 1 && v <= 99_999_999,
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
// A template path is checked before connecting; by default it names an existing file.
const mockStatSync = mock.fn((_path: string): { isFile(): boolean } => ({ isFile: () => true }));

mock.module("node:fs", {
	namedExports: {
		mkdtempSync: mockMkdtempSync,
		rmSync: mockRmSync,
		statSync: mockStatSync,
		writeFileSync: mockWriteFileSync,
	},
});

mock.module("node:os", {
	namedExports: {
		tmpdir: () => "/fake-tmp",
	},
});

// Import AFTER mock registration
const { executeProtoSync, normalizeServerUrl, parseTimeoutOption } = await import("../../src/commands/proto-sync.ts");

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
		mockStatSync.mock.resetCalls();
	});

	// -----------------------------------------------------------------------
	// URL normalization
	// -----------------------------------------------------------------------

	describe("URL normalization", () => {
		// The documented usage is `--from localhost:5000`: an address without a scheme. Hosts are
		// varied so that a rule keyed on the first letters of the address cannot pass by luck.
		for (const host of ["localhost:5000", "127.0.0.1:5000", "api.internal:443", "hostname:5000", "[::1]:5000"]) {
			it(`should prepend http:// to the bare address ${host}`, async () => {
				await captureConsoleLog(async () => {
					await executeProtoSync({
						from: host,
						out: "./gen",
						dryRun: true,
					});
				});

				assert.strictEqual(mockFetchReflectionData.mock.calls.length, 1);
				assert.strictEqual(
					mockFetchReflectionData.mock.calls[0]!.arguments[0],
					`http://${host}`,
				);
			});
		}

		// A host name that merely begins with the letters "http" is still a bare address.
		it("should prepend http:// to a bare address whose host name starts with http", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "httpbin.local:5000",
					out: "./gen",
					dryRun: true,
				});
			});

			assert.strictEqual(
				mockFetchReflectionData.mock.calls[0]!.arguments[0],
				"http://httpbin.local:5000",
			);
		});

		// A scheme the command cannot speak is refused before anything happens: no reflection
		// request, no buf, no temporary directory, no output.
		for (const dryRun of [true, false]) {
			it(`refuses ftp://h:5 without calling reflection or buf and without creating a temporary directory (dryRun: ${dryRun})`, async () => {
				const logs: string[] = [];
				const originalLog = console.log;
				console.log = (...args: unknown[]) => {
					logs.push(args.map(String).join(" "));
				};
				try {
					await assert.rejects(executeProtoSync({ from: "ftp://h:5", out: "./gen", dryRun }), /"ftp"/);
				} finally {
					console.log = originalLog;
				}

				assert.strictEqual(mockFetchReflectionData.mock.calls.length, 0, "reflection must not be called");
				assert.strictEqual(mockFetchFileDescriptorSetBinary.mock.calls.length, 0, "descriptor fetch must not be called");
				assert.strictEqual(mockExecFileSync.mock.calls.length, 0, "buf must not be run");
				assert.strictEqual(mockMkdtempSync.mock.calls.length, 0, "no temporary directory may be created");
				assert.strictEqual(mockWriteFileSync.mock.calls.length, 0, "nothing may be written");
				assert.deepStrictEqual(logs, [], "nothing may be printed");
			});
		}

		// An address the URL parser rejects used to reach the client and fail there as `TypeError: Invalid URL`
		// after the banner; it is now refused by name before anything is printed or connected.
		for (const [from, message] of [
			["", "--from must not be empty. Use host:port, http://... or https://..."],
			["   ", "--from must not be empty. Use host:port, http://... or https://..."],
			["local host:5305", '--from "local host:5305" is not a valid server address. Use host:port, http://... or https://...'],
			["http://", '--from "http://" is not a valid server address. Use host:port, http://... or https://...'],
			["localhost:99999", '--from "localhost:99999" is not a valid server address. Use host:port, http://... or https://...'],
		] as const) {
			for (const dryRun of [true, false]) {
				it(`refuses the address ${JSON.stringify(from)} by name, before connecting (dryRun: ${dryRun})`, async () => {
					const logs: string[] = [];
					const originalLog = console.log;
					console.log = (...args: unknown[]) => {
						logs.push(args.map(String).join(" "));
					};
					try {
						await assert.rejects(executeProtoSync({ from, out: "./gen", dryRun }), (err: unknown) => err instanceof CliError && err.message === message);
					} finally {
						console.log = originalLog;
					}

					assert.strictEqual(mockFetchReflectionData.mock.calls.length, 0);
					assert.strictEqual(mockFetchFileDescriptorSetBinary.mock.calls.length, 0);
					assert.deepStrictEqual(logs, [], "nothing may be printed");
				});
			}
		}

		it("passes an upper-case scheme on as typed: not refused, not prefixed", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({ from: "HTTP://h:5", out: "./gen", dryRun: true });
			});

			assert.strictEqual(mockFetchReflectionData.mock.calls[0]!.arguments[0], "HTTP://h:5");
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

		// buf reads the descriptor set from the file it is given, so the file has to hold exactly the
		// bytes the server returned, live inside the temporary directory that is cleaned up later,
		// and be the file buf is pointed at.
		it("writes the fetched descriptor bytes into the temporary directory and hands that very file to buf", async () => {
			const fetched = new Uint8Array([0x0a, 0x09, 0x08, 0x07, 0x06]);
			mockFetchFileDescriptorSetBinary.mock.mockImplementationOnce(async () => fetched);

			await captureConsoleLog(async () => {
				await executeProtoSync({
					from: "http://localhost:5000",
					out: "./gen",
				});
			});

			assert.strictEqual(mockWriteFileSync.mock.calls.length, 1);
			const [path, data] = mockWriteFileSync.mock.calls[0]!.arguments;
			assert.deepStrictEqual(data, fetched);
			assert.strictEqual(path, "/fake-tmp/connectum-proto-sync-XXXXXX/descriptors.binpb");

			const [, args] = mockExecFileSync.mock.calls[0]!.arguments;
			assert.deepStrictEqual(args?.slice(0, 2), ["generate", path]);
			assert.strictEqual(mockRmSync.mock.calls[0]!.arguments[0], "/fake-tmp/connectum-proto-sync-XXXXXX");
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

		it("removes the temporary directory and stops before buf when writing the descriptor file fails", async () => {
			const writeFailure = new Error("ENOSPC: no space left on device");
			mockWriteFileSync.mock.mockImplementationOnce(() => {
				throw writeFailure;
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
				(err: unknown) => err === writeFailure,
			);

			assert.strictEqual(mockMkdtempSync.mock.calls.length, 1);
			assert.strictEqual(mockRmSync.mock.calls.length, 1, "the directory that was created must be removed");
			const [removed, removeOptions] = mockRmSync.mock.calls[0]!.arguments;
			assert.strictEqual(removed, "/fake-tmp/connectum-proto-sync-XXXXXX");
			assert.deepStrictEqual(removeOptions, { recursive: true, force: true });
			assert.strictEqual(mockExecFileSync.mock.calls.length, 0, "buf must not run without a descriptor file");
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

		it("should say that buf is not on the PATH when it is not installed, keeping the spawn error as the cause", async () => {
			const spawnError = new Error("spawnSync buf ENOENT") as NodeJS.ErrnoException;
			spawnError.code = "ENOENT";
			mockExecFileSync.mock.mockImplementationOnce(() => {
				throw spawnError;
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
					assert.ok(err instanceof CliError);
					assert.match(err.message, /^buf was not found on the PATH\./);
					assert.ok(err.message.includes("https://buf.build/docs/installation"), err.message);
					assert.strictEqual(err.cause, spawnError);
					return true;
				},
			);
		});

		it("should name the exit code of a failing buf generate, which has printed its own diagnostic", async () => {
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
				(err: unknown) => {
					assert.ok(err instanceof CliError);
					assert.strictEqual(err.message, "buf generate failed with exit code 1; see its output above.");
					return true;
				},
			);
		});

		it("should name the signal when buf generate is killed", async () => {
			mockExecFileSync.mock.mockImplementationOnce(() => {
				const error = new Error("Command failed: buf generate") as any;
				error.status = null;
				error.signal = "SIGKILL";
				throw error;
			});

			await assert.rejects(
				executeProtoSync({ from: "http://localhost:5000", out: "./gen" }),
				{ message: "buf generate was terminated by SIGKILL." },
			);
		});

		it("should refuse a template that is not an existing file before connecting", async () => {
			mockStatSync.mock.mockImplementationOnce(() => {
				throw Object.assign(new Error("ENOENT: no such file or directory, stat 'nonexist.yaml'"), { code: "ENOENT" });
			});

			await assert.rejects(
				executeProtoSync({ from: "http://localhost:5000", out: "./gen", template: "nonexist.yaml" }),
				{ message: '--template "nonexist.yaml" is not an existing file.' },
			);
			assert.strictEqual(mockFetchFileDescriptorSetBinary.mock.calls.length, 0, "the descriptors must not be fetched");
			assert.strictEqual(mockMkdtempSync.mock.calls.length, 0, "no temporary directory may be created");
		});

		it("should refuse a template that is a directory", async () => {
			mockStatSync.mock.mockImplementationOnce(() => ({ isFile: () => false }));

			await assert.rejects(
				executeProtoSync({ from: "http://localhost:5000", out: "./gen", template: "some-dir" }),
				{ message: '--template "some-dir" is not an existing file.' },
			);
			assert.strictEqual(mockFetchFileDescriptorSetBinary.mock.calls.length, 0);
		});

		it("should not look at the template in a dry run, which never uses it", async () => {
			await captureConsoleLog(async () => {
				await executeProtoSync({ from: "http://localhost:5000", out: "./gen", template: "nonexist.yaml", dryRun: true });
			});
			assert.strictEqual(mockFetchReflectionData.mock.calls.length, 1);
			assert.strictEqual(mockStatSync.mock.calls.length, 0);
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

	// The command definition (name, description, arguments, run handler) is not checked here: those
	// are constants and wiring, and the process-level suites run the built command and observe what
	// they mean (a missing --from or --out is refused, --dry-run and --template are honoured,
	// --help lists every flag).

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

describe("normalizeServerUrl", () => {
	// A bare address gets http:// in front of it, whatever letters its host name starts with.
	for (const [from, expected] of [
		["localhost:5000", "http://localhost:5000"],
		["httpbin.local:5000", "http://httpbin.local:5000"],
		["https-proxy.internal:443", "http://https-proxy.internal:443"],
		["[::1]:5000", "http://[::1]:5000"],
		["host:5000/path", "http://host:5000/path"],
	] as const) {
		it(`prefixes the bare address ${from}`, () => {
			assert.strictEqual(normalizeServerUrl(from), expected);
		});
	}

	// An http(s) URL is used exactly as typed, in any letter case of the scheme.
	for (const from of ["http://h:5", "https://h:5", "HTTP://h:5", "Https://h:5"]) {
		it(`leaves the URL ${from} unchanged`, () => {
			assert.strictEqual(normalizeServerUrl(from), from);
		});
	}

	it("refuses ftp://h:5 with a message that names the scheme and the accepted forms", () => {
		assert.throws(() => normalizeServerUrl("ftp://h:5"), (err: unknown) => {
			assert.ok(err instanceof Error);
			assert.ok(err.message.includes('"ftp"'), `the scheme must be named, got: ${err.message}`);
			for (const form of ["host:port", "http://", "https://"]) {
				assert.ok(err.message.includes(form), `"${form}" must be listed, got: ${err.message}`);
			}
			return true;
		});
	});

	// The scheme-shaped prefix allows letters, digits, "+", "." and "-" after the first letter.
	for (const [from, scheme] of [["grpc://h:5", "grpc"], ["my-host://x", "my-host"], ["svn+ssh://h", "svn+ssh"], ["FTP://h:5", "FTP"]] as const) {
		it(`refuses ${from} and names ${scheme}`, () => {
			assert.throws(() => normalizeServerUrl(from), (err: unknown) => err instanceof Error && err.message.includes(`"${scheme}"`));
		});
	}

	// Only "<scheme>://" at the very start marks a URL; a colon alone does not.
	it("does not mistake an address with a colon, or a later \"://\", for a foreign scheme", () => {
		assert.strictEqual(normalizeServerUrl("host:5000"), "http://host:5000");
		assert.strictEqual(normalizeServerUrl("host:5000/a://b"), "http://host:5000/a://b");
		assert.strictEqual(normalizeServerUrl("1ftp://h"), "http://1ftp://h");
	});

	it("refuses an empty address by name instead of turning it into the unusable `http://`", () => {
		assert.throws(() => normalizeServerUrl(""), { message: "--from must not be empty. Use host:port, http://... or https://..." });
	});

	it("handles a long hostile input in linear time", () => {
		const hostile = `${"a".repeat(200_000)}!`;
		const started = performance.now();
		assert.strictEqual(normalizeServerUrl(hostile), `http://${hostile}`);
		assert.ok(performance.now() - started < 500, "must not backtrack catastrophically");
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

	// parseTimeoutOption accepts plain decimal digits only, the first one 1 to 9: a value with a
	// leading zero is refused like any other invalid value instead of being read as 7 (or, by a
	// parser that treats a leading zero as octal, as another number).
	it("rejects a leading-zero spelling \"007\" instead of reading it as 7", () => {
		assert.throws(() => parseTimeoutOption("007"), /--timeout must be a positive integer/);
	});

	it("leaves the upper bound to executeProtoSync, which refuses it before connecting and quotes the maximum", async () => {
		mockFetchReflectionData.mock.resetCalls();
		assert.equal(parseTimeoutOption("100000000"), 100000000);
		await assert.rejects(
			executeProtoSync({ from: "localhost:5000", out: "gen", timeoutMs: 100000000, dryRun: true }),
			(err: unknown) => err instanceof Error && /--timeout must be a positive integer/.test(err.message) && err.message.includes("99999999"),
		);
		assert.equal(mockFetchReflectionData.mock.calls.length, 0, "the limit must be refused before any connection");
	});

	it("passes the maximum 99999999 on to the reflection call unchanged", async () => {
		mockFetchReflectionData.mock.resetCalls();
		assert.equal(parseTimeoutOption("99999999"), 99999999);
		await captureConsoleLog(async () => {
			await executeProtoSync({ from: "localhost:5000", out: "gen", timeoutMs: 99999999, dryRun: true });
		});
		assert.equal(mockFetchReflectionData.mock.calls.length, 1);
		assert.deepEqual(mockFetchReflectionData.mock.calls[0]!.arguments[1], { timeoutMs: 99999999 });
	});

	it("names the maximum 99999999 when parseTimeoutOption refuses a malformed value", () => {
		assert.throws(() => parseTimeoutOption("007"), (err: unknown) => err instanceof Error && err.message.includes("99999999"));
	});
});
