/**
 * Option translation tests.
 *
 * The expected numbers are the ones the KafkaJS documentation gives (log levels in "Logging", codec
 * numbers in "Producing Messages"), written out here rather than read from the adapter's own mapping:
 * a test built from the same table as the code would agree with any mistake in it.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { assertKafkaOptions, buildClientConfig, compressionOf, removedKafkaConfigMessage } from "../../src/clientConfig.ts";
import { KafkaAdapter } from "../../src/KafkaAdapter.ts";
import type { KafkaAdapterOptions } from "../../src/types.ts";

const base: KafkaAdapterOptions = { brokers: ["b1:9092"] };

describe("buildClientConfig", () => {
    it("always carries brokers and the resolved client id", () => {
        assert.deepEqual(buildClientConfig(base, "svc"), { brokers: ["b1:9092"], clientId: "svc" });
    });

    it("forwards sasl plain with the same mechanism, username and password", () => {
        const config = buildClientConfig({ ...base, sasl: { mechanism: "plain", username: "u", password: "p" } }, "svc");
        assert.deepEqual(config.sasl, { mechanism: "plain", username: "u", password: "p" });
    });

    it("forwards ssl as given", () => {
        assert.equal(buildClientConfig({ ...base, ssl: true }, "svc").ssl, true);
        assert.deepEqual(buildClientConfig({ ...base, ssl: { ca: "PEM", rejectUnauthorized: true } }, "svc").ssl, { ca: "PEM", rejectUnauthorized: true });
    });

    it("forwards the four timeouts, enforceRequestTimeout and retry", () => {
        const config = buildClientConfig(
            { ...base, connectionTimeout: 1, authenticationTimeout: 2, reauthenticationThreshold: 3, requestTimeout: 4, enforceRequestTimeout: true, retry: { retries: 5, initialRetryTime: 6 } },
            "svc",
        );
        assert.equal(config.connectionTimeout, 1);
        assert.equal(config.authenticationTimeout, 2);
        assert.equal(config.reauthenticationThreshold, 3);
        assert.equal(config.requestTimeout, 4);
        assert.equal(config.enforceRequestTimeout, true);
        assert.deepEqual(config.retry, { retries: 5, initialRetryTime: 6 });
    });

    it("maps the log level names to the numbers KafkaJS documents: nothing 0, error 1, warn 2, info 4, debug 5", () => {
        const levels = { nothing: 0, error: 1, warn: 2, info: 4, debug: 5 } as const;
        for (const [name, number] of Object.entries(levels)) {
            assert.equal(buildClientConfig({ ...base, logLevel: name as keyof typeof levels }, "svc").logLevel, number, name);
        }
    });

    it("leaves unset options out instead of passing undefined", () => {
        const config = buildClientConfig(base, "svc");
        for (const key of ["ssl", "sasl", "logLevel", "retry", "requestTimeout"]) {
            assert.equal(key in config, false, key);
        }
    });

    it("lets clientOptions add what has no portable form, such as a log factory, and override typed options shallowly", () => {
        const logCreator = () => () => undefined;
        const config = buildClientConfig({ ...base, logLevel: "error", retry: { retries: 1 }, clientOptions: { logCreator, retry: { retries: 9 } } }, "svc");
        assert.equal((config as { logCreator?: unknown }).logCreator, logCreator);
        assert.deepEqual(config.retry, { retries: 9 }, "clientOptions replaces retry as a whole");
        assert.equal(config.logLevel, 1);
    });

    it("never lets clientOptions override brokers or clientId", () => {
        const config = buildClientConfig({ ...base, clientOptions: { brokers: ["evil:1"], clientId: "evil" } }, "svc");
        assert.deepEqual(config.brokers, ["b1:9092"]);
        assert.equal(config.clientId, "svc");
    });
});

describe("compressionOf", () => {
    it("maps the names to the codec numbers KafkaJS documents: none 0, gzip 1, snappy 2, lz4 3, zstd 4", () => {
        const codecs = { none: 0, gzip: 1, snappy: 2, lz4: 3, zstd: 4 } as const;
        for (const [name, number] of Object.entries(codecs)) {
            assert.equal(compressionOf({ ...base, producerOptions: { compression: name as keyof typeof codecs } }), number, name);
        }
    });

    it("is undefined when no compression is set", () => {
        assert.equal(compressionOf(base), undefined);
    });
});

describe("option validation", () => {
    it("throws TypeError that names the migration page when the removed kafkaConfig key is passed", () => {
        const legacy = { ...base, kafkaConfig: { ssl: true } } as unknown as KafkaAdapterOptions;
        assert.throws(() => KafkaAdapter(legacy), (err: unknown) => err instanceof TypeError && err.message === removedKafkaConfigMessage && err.message.includes("/en/migration/kafka-adapter-options"));
    });

    it("throws RangeError for a numeric or unknown compression", () => {
        for (const bad of [1, "brotli", null]) {
            const options = { ...base, producerOptions: { compression: bad } } as unknown as KafkaAdapterOptions;
            assert.throws(() => assertKafkaOptions(options), RangeError, String(bad));
        }
    });

    it("throws RangeError for an unknown log level", () => {
        assert.throws(() => assertKafkaOptions({ ...base, logLevel: "verbose" as never }), RangeError);
    });

    it("accepts every documented value", () => {
        for (const compression of ["none", "gzip", "snappy", "lz4", "zstd"] as const) {
            assert.doesNotThrow(() => KafkaAdapter({ ...base, producerOptions: { compression } }));
        }
    });
});

describe("published type declarations", () => {
    it("do not reference the client library", () => {
        const dist = fileURLToPath(new URL("../../dist/", import.meta.url));
        const declarations = readdirSync(dist).filter((name) => name.endsWith(".d.ts"));
        assert.ok(declarations.length > 0, "build the package first: dist/*.d.ts is missing");
        for (const name of declarations) {
            const source = readFileSync(`${dist}${name}`, "utf8");
            assert.doesNotMatch(source, /from\s+['"]kafkajs['"]|import\(['"]kafkajs['"]\)/, `${name} must not import kafkajs`);
        }
    });
});
