/**
 * Translation of the adapter's own option types into what the Kafka client library expects.
 *
 * The public option types of the package name no client-library types; this module is the
 * only place that knows both vocabularies.
 *
 * @module clientConfig
 */

import type { KafkaConfig } from "kafkajs";
import { CompressionTypes, logLevel } from "kafkajs";
import { defaultHeartbeatIntervalMs } from "./consumeBatch.ts";
import type { KafkaAdapterOptions, KafkaCompression, KafkaLogLevel } from "./types.ts";

/** Codec numbers of the client library, by the name the adapter's option uses. */
const compressionCodecs: Readonly<Record<KafkaCompression, CompressionTypes>> = {
    none: CompressionTypes.None,
    gzip: CompressionTypes.GZIP,
    snappy: CompressionTypes.Snappy,
    lz4: CompressionTypes.LZ4,
    zstd: CompressionTypes.ZSTD,
};

/** Log levels of the client library, by the name the adapter's option uses. */
const logLevels: Readonly<Record<KafkaLogLevel, number>> = {
    nothing: logLevel.NOTHING,
    error: logLevel.ERROR,
    warn: logLevel.WARN,
    info: logLevel.INFO,
    debug: logLevel.DEBUG,
};

/** Message of the error thrown for the option this package no longer accepts. */
export const removedKafkaConfigMessage =
    "KafkaAdapter: the `kafkaConfig` option was removed. Use the typed options (ssl, sasl, connectionTimeout, authenticationTimeout, reauthenticationThreshold, requestTimeout, enforceRequestTimeout, retry, logLevel) and put client-specific settings that have no portable form in `clientOptions`. See https://connectum.dev/en/migration/kafka-adapter-options";

/** SASL mechanisms the typed `sasl` option carries. A mechanism the client library supports only through `clientOptions` does not belong here. */
const saslMechanisms = ["plain", "scram-sha-256", "scram-sha-512", "oauthbearer", "aws"] as const;

/** A short, safe rendering of a rejected value for an error message. */
function describe(value: unknown): string {
    if (typeof value === "number") {
        return String(value);
    }
    if (typeof value === "string" || typeof value === "boolean" || value === undefined || value === null) {
        return JSON.stringify(value) ?? "undefined";
    }
    return Array.isArray(value) ? "an array" : typeof value;
}

function assertBrokers(brokers: unknown): void {
    if (!Array.isArray(brokers)) {
        throw new TypeError(`KafkaAdapter: brokers must be an array of broker addresses such as ["localhost:9092"], got ${describe(brokers)}`);
    }
    if (brokers.length === 0) {
        throw new RangeError("KafkaAdapter: brokers must contain at least one broker address");
    }
    brokers.forEach((entry: unknown, index) => {
        if (typeof entry !== "string" || entry.trim() === "") {
            throw new TypeError(`KafkaAdapter: brokers[${index}] must be a non-empty "host:port" string, got ${describe(entry)}`);
        }
    });
}

function assertSessionTimeout(sessionTimeout: unknown): void {
    if (sessionTimeout === undefined) {
        return;
    }
    // KafkaJS refuses a session timeout that is not above the heartbeat interval, but only when the first consumer is created.
    if (typeof sessionTimeout !== "number" || !Number.isFinite(sessionTimeout) || sessionTimeout <= defaultHeartbeatIntervalMs) {
        throw new RangeError(
            `KafkaAdapter: consumerOptions.sessionTimeout must be a finite number of milliseconds above the heartbeat interval (${defaultHeartbeatIntervalMs}), got ${describe(sessionTimeout)}`,
        );
    }
}

function assertRetry(retry: unknown): void {
    if (retry === undefined) {
        return;
    }
    if (typeof retry !== "object" || retry === null || Array.isArray(retry)) {
        throw new TypeError(`KafkaAdapter: retry must be an object, got ${describe(retry)}`);
    }
    const { retries, ...times } = retry as Record<string, unknown>;
    if (retries !== undefined && (typeof retries !== "number" || !Number.isInteger(retries) || retries < 0)) {
        throw new RangeError(`KafkaAdapter: retry.retries must be a non-negative integer, got ${describe(retries)}`);
    }
    for (const key of ["maxRetryTime", "initialRetryTime", "factor", "multiplier"]) {
        const value = times[key];
        if (value !== undefined && (typeof value !== "number" || !Number.isFinite(value) || value < 0)) {
            throw new RangeError(`KafkaAdapter: retry.${key} must be a non-negative finite number, got ${describe(value)}`);
        }
    }
}

function assertSasl(sasl: unknown): void {
    if (sasl === undefined) {
        return;
    }
    if (typeof sasl !== "object" || sasl === null || Array.isArray(sasl)) {
        throw new TypeError(`KafkaAdapter: sasl must be an object with a mechanism, got ${describe(sasl)}`);
    }
    const mechanism = (sasl as { mechanism?: unknown }).mechanism;
    if (typeof mechanism !== "string" || !(saslMechanisms as readonly string[]).includes(mechanism)) {
        throw new RangeError(`KafkaAdapter: sasl.mechanism must be one of ${saslMechanisms.join(", ")}, got ${describe(mechanism)}`);
    }
}

/**
 * Validate the options that carry a closed set of values or that were removed, and throw
 * at construction time instead of connecting with a different configuration than asked for.
 */
export function assertKafkaOptions(options: KafkaAdapterOptions): void {
    if (typeof options !== "object" || options === null) {
        throw new TypeError(`KafkaAdapter: options must be an object with a \`brokers\` list, got ${describe(options)}`);
    }
    assertBrokers(options.brokers);
    const clientId: unknown = options.clientId;
    if (clientId !== undefined && (typeof clientId !== "string" || clientId.trim() === "")) {
        throw new TypeError(`KafkaAdapter: clientId must be a non-empty string, got ${describe(clientId)}`);
    }
    assertSessionTimeout(options.consumerOptions?.sessionTimeout);
    assertRetry(options.retry);
    assertSasl(options.sasl);
    // A JavaScript caller (or one that casts) can still pass the old key; ignoring it would silently drop its ssl and sasl.
    if ("kafkaConfig" in options && (options as { kafkaConfig?: unknown }).kafkaConfig !== undefined) {
        throw new TypeError(removedKafkaConfigMessage);
    }
    const compression: unknown = options.producerOptions?.compression;
    if (compression !== undefined && (typeof compression !== "string" || !Object.hasOwn(compressionCodecs, compression))) {
        throw new RangeError(`KafkaAdapter: producerOptions.compression must be one of ${Object.keys(compressionCodecs).join(", ")}, got ${JSON.stringify(compression)}`);
    }
    const level: unknown = options.logLevel;
    if (level !== undefined && (typeof level !== "string" || !Object.hasOwn(logLevels, level))) {
        throw new RangeError(`KafkaAdapter: logLevel must be one of ${Object.keys(logLevels).join(", ")}, got ${JSON.stringify(level)}`);
    }
}

/** The codec the client library names for `producerOptions.compression`, or `undefined` when it is not set. */
export function compressionOf(options: KafkaAdapterOptions): CompressionTypes | undefined {
    const name = options.producerOptions?.compression;
    return name === undefined ? undefined : compressionCodecs[name];
}

/**
 * Build the client constructor argument: the typed options first, then `clientOptions` over them,
 * then the identity (`brokers`, `clientId`), which `clientOptions` can never override.
 */
export function buildClientConfig(options: KafkaAdapterOptions, clientId: string): KafkaConfig {
    const typed: Partial<KafkaConfig> = {};
    if (options.ssl !== undefined) {
        typed.ssl = options.ssl as NonNullable<KafkaConfig["ssl"]>;
    }
    if (options.sasl !== undefined) {
        typed.sasl = options.sasl as NonNullable<KafkaConfig["sasl"]>;
    }
    if (options.connectionTimeout !== undefined) {
        typed.connectionTimeout = options.connectionTimeout;
    }
    if (options.authenticationTimeout !== undefined) {
        typed.authenticationTimeout = options.authenticationTimeout;
    }
    if (options.reauthenticationThreshold !== undefined) {
        typed.reauthenticationThreshold = options.reauthenticationThreshold;
    }
    if (options.requestTimeout !== undefined) {
        typed.requestTimeout = options.requestTimeout;
    }
    if (options.enforceRequestTimeout !== undefined) {
        typed.enforceRequestTimeout = options.enforceRequestTimeout;
    }
    if (options.retry !== undefined) {
        typed.retry = { ...options.retry };
    }
    if (options.logLevel !== undefined) {
        typed.logLevel = logLevels[options.logLevel];
    }
    return {
        ...typed,
        ...(options.clientOptions as Partial<KafkaConfig> | undefined),
        brokers: options.brokers,
        clientId,
    };
}
