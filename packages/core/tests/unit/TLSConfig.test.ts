/**
 * TLS Configuration tests
 */

import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path/posix";
import { cwd } from "node:process";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getTLSPath, readTLSCertificates } from "../../src/TLSConfig.ts";

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
	});
});
