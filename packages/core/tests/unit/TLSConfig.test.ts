/**
 * TLS Configuration tests
 */

import assert from "node:assert";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path/posix";
import { afterEach, beforeEach, describe, it } from "node:test";
import { getTLSPath, readTLSCertificates } from "../../src/TLSConfig.ts";

describe("TLSConfig", () => {
	let testDir: string;
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		// Save original env
		originalEnv = { ...process.env };

		// Create temp directory for test certificates
		testDir = resolve(tmpdir(), `tls-test-${Date.now()}`);
		mkdirSync(testDir, { recursive: true });
	});

	afterEach(() => {
		// Restore env
		process.env = originalEnv;

		// Clean up test directory
		try {
			rmSync(testDir, { recursive: true, force: true });
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("getTLSPath", () => {
		it("should return TLS path as string", () => {
			const path = getTLSPath();

			assert.ok(path);
			assert.ok(typeof path === "string");
			assert.ok(path.length > 0);
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

			assert.throws(() => {
				readTLSCertificates({
					keyPath: resolve(testDir, "nonexistent.key"),
					certPath,
				});
			});
		});

		it("should throw error if cert file not found with explicit paths", () => {
			const keyPath = resolve(testDir, "test.key");
			writeFileSync(keyPath, "test-key-content");

			assert.throws(() => {
				readTLSCertificates({
					keyPath,
					certPath: resolve(testDir, "nonexistent.crt"),
				});
			});
		});

		it("should throw error if server.key not found in directory", () => {
			const certPath = resolve(testDir, "server.crt");
			writeFileSync(certPath, "server-cert-content");

			assert.throws(() => {
				readTLSCertificates({
					dirPath: testDir,
				});
			});
		});

		it("should throw error if server.crt not found in directory", () => {
			const keyPath = resolve(testDir, "server.key");
			writeFileSync(keyPath, "server-key-content");

			assert.throws(() => {
				readTLSCertificates({
					dirPath: testDir,
				});
			});
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

		it("should read from dirPath when provided without explicit paths", () => {
			const keyPath = resolve(testDir, "server.key");
			const certPath = resolve(testDir, "server.crt");
			writeFileSync(keyPath, "dirpath-key-content");
			writeFileSync(certPath, "dirpath-cert-content");

			const result = readTLSCertificates({ dirPath: testDir });

			assert.strictEqual(result.key.toString(), "dirpath-key-content");
			assert.strictEqual(result.cert.toString(), "dirpath-cert-content");
		});
	});
});
