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

/**
 * Validate the options that carry a closed set of values or that were removed, and throw
 * at construction time instead of connecting with a different configuration than asked for.
 */
export function assertKafkaOptions(options: KafkaAdapterOptions): void {
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
