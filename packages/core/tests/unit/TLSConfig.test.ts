/**
 * TLS Configuration tests
 */

import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { relative } from "node:path";
import { resolve } from "node:path/posix";
import { cwd } from "node:process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { createServer } from "../../src/Server.ts";
import { getTLSPath, loadTLSCertificates, readTLSCertificates } from "../../src/TLSConfig.ts";

describe("TLSConfig", () => {
	let testDir: string;
	let originalEnv: { TLS_DIR_PATH: string | undefined; NODE_ENV: string | undefined };

	beforeEach(() => {
		// Save the variables the tests change. They are restored key by key:
		// replacing `process.env` with a copy would leave `env-var` reading the old object.
		originalEnv = { TLS_DIR_PATH: process.env.TLS_DIR_PATH, NODE_ENV: process.env.NODE_ENV };

		// Create temp directory for test certificates
		testDir = resolve(tmpdir(), `tls-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		// Restore env
		for (const name of ["TLS_DIR_PATH", "NODE_ENV"] as const) {
			const value = originalEnv[name];
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}

		// Clean up test directory
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("getTLSPath", () => {
		// Configuration guide, TLS_DIR_PATH: the variable sets the directory; without it
		// the default is `../../../keys` relative to cwd in development and cwd in production.
		it("should return TLS_DIR_PATH verbatim when it is set, in development and in production alike", () => {
			process.env.TLS_DIR_PATH = "/etc/ssl/certs";

			process.env.NODE_ENV = "development";
			assert.strictEqual(getTLSPath(), "/etc/ssl/certs");

			process.env.NODE_ENV = "production";
			assert.strictEqual(getTLSPath(), "/etc/ssl/certs");
		});

		it("should default to ../../../keys relative to cwd in development", () => {
			delete process.env.TLS_DIR_PATH;
			process.env.NODE_ENV = "development";

			assert.strictEqual(getTLSPath(), resolve(cwd(), "../../../keys"));
		});

		it("should default to ../../../keys relative to cwd when NODE_ENV is not set", () => {
			delete process.env.TLS_DIR_PATH;
			delete process.env.NODE_ENV;

			assert.strictEqual(getTLSPath(), resolve(cwd(), "../../../keys"));
		});

		it("should default to cwd in production", () => {
			delete process.env.TLS_DIR_PATH;
			process.env.NODE_ENV = "production";

			assert.strictEqual(getTLSPath(), cwd());
		});
	});

	describe("readTLSCertificates", () => {
		it("should read certificates from explicit paths", () => {
			const keyPath = resolve(testDir, "test.key");
			const certPath = resolve(testDir, "test.crt");

			writeFileSync(keyPath, "test-key-content");
			writeFileSync(certPath, "test-cert-content");

			const result = readTLSCertificates({
				keyPath,
				certPath,
			});

			assert.ok(result.key);
			assert.ok(result.cert);
			assert.strictEqual(result.key.toString(), "test-key-content");
			assert.strictEqual(result.cert.toString(), "test-cert-content");
		});

		it("should read certificates from directory path", () => {
			const keyPath = resolve(testDir, "server.key");
			const certPath = resolve(testDir, "server.crt");

			writeFileSync(keyPath, "server-key-content");
			writeFileSync(certPath, "server-cert-content");

			const result = readTLSCertificates({
				dirPath: testDir,
			});

			assert.ok(result.key);
			assert.ok(result.cert);
			assert.strictEqual(result.key.toString(), "server-key-content");
			assert.strictEqual(result.cert.toString(), "server-cert-content");
		});

		it("should throw error if key file not found with explicit paths", () => {
			const certPath = resolve(testDir, "test.crt");
			writeFileSync(certPath, "test-cert-content");

			// A missing file surfaces as the file system's ENOENT naming the
			// missing path (Node.js fs error contract), not as a generic failure.
			const missing = resolve(testDir, "nonexistent.key");
			assert.throws(
				() => {
					readTLSCertificates({
						keyPath: missing,
						certPath,
					});
				},
				{ code: "ENOENT", path: missing },
			);
		});

		it("should throw error if cert file not found with explicit paths", () => {
			const keyPath = resolve(testDir, "test.key");
			writeFileSync(keyPath, "test-key-content");

			const missing = resolve(testDir, "nonexistent.crt");
			assert.throws(
				() => {
					readTLSCertificates({
						keyPath,
						certPath: missing,
					});
				},
				{ code: "ENOENT", path: missing },
			);
		});

		it("should throw error if server.key not found in directory", () => {
			const certPath = resolve(testDir, "server.crt");
			writeFileSync(certPath, "server-cert-content");

			assert.throws(
				() => {
					readTLSCertificates({
						dirPath: testDir,
					});
				},
				{ code: "ENOENT", path: resolve(testDir, "server.key") },
			);
		});

		it("should throw error if server.crt not found in directory", () => {
			const keyPath = resolve(testDir, "server.key");
			writeFileSync(keyPath, "server-key-content");

			assert.throws(
				() => {
					readTLSCertificates({
						dirPath: testDir,
					});
				},
				{ code: "ENOENT", path: resolve(testDir, "server.crt") },
			);
		});

		it("should prioritize explicit paths over dirPath", () => {
			// Create files in dirPath
			const dirKeyPath = resolve(testDir, "server.key");
			const dirCertPath = resolve(testDir, "server.crt");
			writeFileSync(dirKeyPath, "dir-key-content");
			writeFileSync(dirCertPath, "dir-cert-content");

			// Create files for explicit paths
			const explicitKeyPath = resolve(testDir, "explicit.key");
			const explicitCertPath = resolve(testDir, "explicit.crt");
			writeFileSync(explicitKeyPath, "explicit-key-content");
			writeFileSync(explicitCertPath, "explicit-cert-content");

			const result = readTLSCertificates({
				keyPath: explicitKeyPath,
				certPath: explicitCertPath,
				dirPath: testDir,
			});

			// Should use explicit paths, not dirPath
			assert.strictEqual(result.key.toString(), "explicit-key-content");
			assert.strictEqual(result.cert.toString(), "explicit-cert-content");
		});

		it("should read server.key and server.crt from TLS_DIR_PATH when no path option is given", () => {
			writeFileSync(resolve(testDir, "server.key"), "env-key-content");
			writeFileSync(resolve(testDir, "server.crt"), "env-cert-content");
			process.env.TLS_DIR_PATH = testDir;

			const result = readTLSCertificates();

			assert.strictEqual(result.key.toString(), "env-key-content");
			assert.strictEqual(result.cert.toString(), "env-cert-content");
		});

		it("should prefer dirPath over TLS_DIR_PATH", () => {
			const otherDir = resolve(testDir, "other");
			mkdirSync(otherDir);
			writeFileSync(resolve(testDir, "server.key"), "dirpath-key-content");
			writeFileSync(resolve(testDir, "server.crt"), "dirpath-cert-content");
			writeFileSync(resolve(otherDir, "server.key"), "env-key-content");
			writeFileSync(resolve(otherDir, "server.crt"), "env-cert-content");
			process.env.TLS_DIR_PATH = otherDir;

			const result = readTLSCertificates({ dirPath: testDir });

			assert.strictEqual(result.key.toString(), "dirpath-key-content");
			assert.strictEqual(result.cert.toString(), "dirpath-cert-content");
		});

		it("should resolve relative explicit paths against the current working directory", () => {
			writeFileSync(resolve(testDir, "rel.key"), "rel-key-content");
			writeFileSync(resolve(testDir, "rel.crt"), "rel-cert-content");

			const result = readTLSCertificates({
				keyPath: relative(cwd(), resolve(testDir, "rel.key")),
				certPath: relative(cwd(), resolve(testDir, "rel.crt")),
			});

			assert.strictEqual(result.key.toString(), "rel-key-content");
			assert.strictEqual(result.cert.toString(), "rel-cert-content");
		});

		it("should prefer explicit paths over TLS_DIR_PATH", () => {
			writeFileSync(resolve(testDir, "server.key"), "env-key-content");
			writeFileSync(resolve(testDir, "server.crt"), "env-cert-content");
			writeFileSync(resolve(testDir, "own.key"), "own-key-content");
			writeFileSync(resolve(testDir, "own.crt"), "own-cert-content");
			process.env.TLS_DIR_PATH = testDir;

			const result = readTLSCertificates({ keyPath: resolve(testDir, "own.key"), certPath: resolve(testDir, "own.crt") });

			assert.strictEqual(result.key.toString(), "own-key-content");
			assert.strictEqual(result.cert.toString(), "own-cert-content");
		});

		describe("a single explicit path", () => {
			// The directory holds a complete, readable pair, so a loader that falls back
			// to it would start without error but serve another certificate than the
			// operator named. The path the operator gave does not exist, so any attempt
			// to read it would surface as ENOENT instead of the configuration error.
			function writeDirectoryPair(): void {
				writeFileSync(resolve(testDir, "server.key"), "dir-key-content");
				writeFileSync(resolve(testDir, "server.crt"), "dir-cert-content");
			}

			function assertConfigurationError(error: unknown, given: "keyPath" | "certPath", missing: "keyPath" | "certPath"): true {
				assert.ok(error instanceof Error, "an Error is expected");
				assert.notStrictEqual((error as NodeJS.ErrnoException).code, "ENOENT", "the configuration error must come before any file is read");
				assert.ok(error.message.includes(`"${given}" is set`), `message names the given parameter: ${error.message}`);
				assert.ok(error.message.includes(`"${missing}" is not`), `message names the missing parameter: ${error.message}`);
				return true;
			}

			it("should reject keyPath without certPath instead of reading the directory", () => {
				writeDirectoryPair();

				assert.throws(
					() => readTLSCertificates({ keyPath: resolve(testDir, "only.key"), dirPath: testDir }),
					(error) => assertConfigurationError(error, "keyPath", "certPath"),
				);
			});

			it("should reject certPath without keyPath instead of reading the directory", () => {
				writeDirectoryPair();

				assert.throws(
					() => readTLSCertificates({ certPath: resolve(testDir, "only.crt"), dirPath: testDir }),
					(error) => assertConfigurationError(error, "certPath", "keyPath"),
				);
			});

			it("should reject a single path when the directory comes from TLS_DIR_PATH", () => {
				writeDirectoryPair();
				process.env.TLS_DIR_PATH = testDir;

				assert.throws(
					() => readTLSCertificates({ keyPath: resolve(testDir, "only.key") }),
					(error) => assertConfigurationError(error, "keyPath", "certPath"),
				);
			});

			it("should reject an existing single file as well, not only a missing one", () => {
				writeDirectoryPair();
				writeFileSync(resolve(testDir, "only.key"), "only-key-content");

				assert.throws(
					() => readTLSCertificates({ keyPath: resolve(testDir, "only.key"), dirPath: testDir }),
					(error) => assertConfigurationError(error, "keyPath", "certPath"),
				);
			});

			it("should treat an empty string as not supplied and reject the pair it leaves incomplete", () => {
				writeDirectoryPair();

				assert.throws(
					() => readTLSCertificates({ keyPath: resolve(testDir, "only.key"), certPath: "", dirPath: testDir }),
					(error) => assertConfigurationError(error, "keyPath", "certPath"),
				);
				assert.throws(
					() => readTLSCertificates({ keyPath: "", certPath: resolve(testDir, "only.crt"), dirPath: testDir }),
					(error) => assertConfigurationError(error, "certPath", "keyPath"),
				);
			});

			it("should make server.start() reject with the configuration error and leave no listener", async () => {
				writeDirectoryPair();
				const server = createServer({ services: [], port: 0, host: "127.0.0.1", tls: { certPath: resolve(testDir, "only.crt"), dirPath: testDir } });

				await assert.rejects(
					() => server.start(),
					(error) => assertConfigurationError(error, "certPath", "keyPath"),
				);
				assert.strictEqual(server.address, null);
			});

			it("should read the directory when both explicit paths are empty strings", () => {
				writeDirectoryPair();

				const result = readTLSCertificates({ keyPath: "", certPath: "", dirPath: testDir });

				assert.strictEqual(result.key.toString(), "dir-key-content");
				assert.strictEqual(result.cert.toString(), "dir-cert-content");
			});
		});
	});

	describe("failures name the file and the setting that supplied its path", () => {
		/** A throwaway self-signed pair; no key material is committed. */
		function writePair(dir: string, name: string): { keyPath: string; certPath: string } {
			const keyPath = resolve(dir, `${name}.key`);
			const certPath = resolve(dir, `${name}.crt`);
			execFileSync(
				"openssl",
				["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes", "-days", "1", "-subj", `/CN=${name}`, "-keyout", keyPath, "-out", certPath],
				{ stdio: "ignore" },
			);
			return { keyPath, certPath };
		}

		const NOT_PEM = "this is not a PEM file\n";

		describe("a file that cannot be read", () => {
			it("names the explicit key path and tls.keyPath, and keeps code, path and cause", () => {
				const { certPath } = writePair(testDir, "good");
				const missing = resolve(testDir, "missing.key");

				assert.throws(
					() => readTLSCertificates({ keyPath: missing, certPath }),
					(error: NodeJS.ErrnoException) => {
						assert.ok(error.message.includes("tls.keyPath"), error.message);
						assert.ok(error.message.includes(missing), error.message);
						assert.strictEqual(error.code, "ENOENT");
						assert.strictEqual(error.path, missing);
						assert.ok(error.cause instanceof Error);
						return true;
					},
				);
			});

			it("names tls.certPath for a missing certificate", () => {
				const { keyPath } = writePair(testDir, "good");

				assert.throws(
					() => readTLSCertificates({ keyPath, certPath: resolve(testDir, "missing.crt") }),
					(error: Error) => error.message.includes("tls.certPath") && error.message.includes("certificate file"),
				);
			});

			it("names tls.dirPath when the directory comes from the option", () => {
				assert.throws(
					() => readTLSCertificates({ dirPath: testDir }),
					(error: Error) => error.message.includes("tls.dirPath") && error.message.includes(resolve(testDir, "server.key")),
				);
			});

			it("names TLS_DIR_PATH when the directory comes from the variable", () => {
				process.env.TLS_DIR_PATH = testDir;

				assert.throws(
					() => readTLSCertificates(),
					(error: Error) => error.message.includes("TLS_DIR_PATH") && error.message.includes(resolve(testDir, "server.key")),
				);
			});

			it("says the default directory was used, and which one, when neither is set", () => {
				delete process.env.TLS_DIR_PATH;
				process.env.NODE_ENV = "production";

				assert.throws(
					() => readTLSCertificates({}),
					(error: Error) => error.message.includes("default TLS directory") && error.message.includes(`${resolve(cwd())}/server.key`),
				);
			});
		});

		describe("loadTLSCertificates", () => {
			it("returns the key and certificate of a valid pair", () => {
				const pair = writePair(testDir, "good");

				const result = loadTLSCertificates(pair);

				assert.deepStrictEqual(result.key, readFileSync(pair.keyPath));
				assert.deepStrictEqual(result.cert, readFileSync(pair.certPath));
			});

			it("names the key file and tls.keyPath when the key is not PEM", () => {
				const { certPath } = writePair(testDir, "good");
				const keyPath = resolve(testDir, "bad.key");
				writeFileSync(keyPath, NOT_PEM);

				assert.throws(
					() => loadTLSCertificates({ keyPath, certPath }),
					(error: Error) => {
						assert.ok(error.message.includes(keyPath), error.message);
						assert.ok(error.message.includes("tls.keyPath"), error.message);
						assert.ok(error.message.includes("private key"), error.message);
						assert.ok(error.cause instanceof Error, "the OpenSSL error is kept as cause");
						return true;
					},
				);
			});

			it("names the certificate file and tls.certPath when the certificate is not PEM", () => {
				const { keyPath } = writePair(testDir, "good");
				const certPath = resolve(testDir, "bad.crt");
				writeFileSync(certPath, NOT_PEM);

				assert.throws(
					() => loadTLSCertificates({ keyPath, certPath }),
					(error: Error) => error.message.includes(certPath) && error.message.includes("tls.certPath") && error.message.includes("certificate"),
				);
			});

			it("names both files when the key does not belong to the certificate", () => {
				const first = writePair(testDir, "first");
				const second = writePair(testDir, "second");

				assert.throws(
					() => loadTLSCertificates({ keyPath: first.keyPath, certPath: second.certPath }),
					(error: Error) => error.message.includes(first.keyPath) && error.message.includes(second.certPath) && error.message.includes("does not match"),
				);
			});

			it("accepts an encrypted key when the passphrase is given, and names the key when it is not", () => {
				const keyPath = resolve(testDir, "enc.key");
				const certPath = resolve(testDir, "enc.crt");
				execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-days", "1", "-subj", "/CN=enc", "-passout", "pass:secret", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });

				assert.doesNotThrow(() => loadTLSCertificates({ keyPath, certPath }, { passphrase: "secret" }));
				assert.throws(
					() => loadTLSCertificates({ keyPath, certPath }),
					(error: Error) => error.message.includes(keyPath) && error.message.includes("tls.keyPath"),
				);
			});

			it("names tls.dirPath and server.key for a bad file in the directory", () => {
				const { certPath } = writePair(testDir, "good");
				writeFileSync(resolve(testDir, "server.key"), NOT_PEM);
				writeFileSync(resolve(testDir, "server.crt"), readFileSync(certPath));

				assert.throws(
					() => loadTLSCertificates({ dirPath: testDir }),
					(error: Error) => error.message.includes(resolve(testDir, "server.key")) && error.message.includes("tls.dirPath"),
				);
			});
		});

		it("starts with an encrypted key when http2Options carries the passphrase", async () => {
			const keyPath = resolve(testDir, "enc.key");
			const certPath = resolve(testDir, "enc.crt");
			execFileSync("openssl", ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-days", "1", "-subj", "/CN=enc", "-passout", "pass:secret", "-keyout", keyPath, "-out", certPath], { stdio: "ignore" });
			const server = createServer({ services: [], port: 0, host: "127.0.0.1", tls: { keyPath, certPath }, http2Options: { passphrase: "secret" } });

			await server.start();
			try {
				assert.ok(server.address?.port);
			} finally {
				await server.stop();
			}
		});

		it("makes server.start() reject with the file and the option, and leaves no listener", async () => {
			const { certPath } = writePair(testDir, "good");
			const keyPath = resolve(testDir, "bad.key");
			writeFileSync(keyPath, NOT_PEM);
			const server = createServer({ services: [], port: 0, host: "127.0.0.1", tls: { keyPath, certPath } });

			await assert.rejects(
				() => server.start(),
				(error: Error) => error.message.includes(keyPath) && error.message.includes("tls.keyPath"),
			);
			assert.strictEqual(server.address, null);
		});
	});
});
