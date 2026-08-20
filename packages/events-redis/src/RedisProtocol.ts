/**
 * Redis protocol configuration and reply normalization.
 *
 * ioredis 6 can expose the same RESP3 map as either a flat array
 * (`replyMapping: "legacy"`) or a plain object (`replyMapping: "resp3"`).
 * The adapter normalizes those wire-specific shapes before applying EventBus
 * semantics.
 *
 * @module RedisProtocol
 */

import type { RedisOptions } from "ioredis";

export type RedisProtocolVersion = 2 | 3;
export type RedisReplyMapping = "legacy" | "resp3";

export interface RedisReplyContext {
    readonly protocol: RedisProtocolVersion;
    readonly replyMapping: RedisReplyMapping;
}

export type RedisStreamEntry = [id: string, fields: string[]];
export type RedisStreamReadResult = [stream: string, entries: RedisStreamEntry[]][];
export type RedisAutoClaimResult = [nextStartId: string, entries: RedisStreamEntry[], deletedIds: string[]];
export type RedisPendingDetail = [entryId: string, consumer: string, idleMs: number, deliveryCount: number];

type RedisConstructorOptions = RedisOptions & {
    protocol: RedisProtocolVersion;
    replyMapping?: RedisReplyMapping;
};

/** Error raised when Redis returns a shape the adapter cannot interpret safely. */
export class RedisReplyShapeError extends Error {
    readonly command: string;
    readonly context: RedisReplyContext;

    constructor(options: { command: string; context: RedisReplyContext; detail: string }) {
        super(`RedisAdapter: unsupported ${options.command} reply for RESP${options.context.protocol}/${options.context.replyMapping}: ${options.detail}`);
        this.name = "RedisReplyShapeError";
        this.command = options.command;
        this.context = options.context;
    }
}

/** Resolve the stable adapter defaults while preserving caller-owned options. */
export function resolveRedisOptions(redisOptions?: RedisOptions, connectionName?: string): RedisConstructorOptions {
    const { protocol, replyMapping, ...rest } = redisOptions ?? {};
    const resolvedProtocol = protocol ?? 2;

    if (resolvedProtocol === 2 && replyMapping === "resp3") {
        throw new TypeError('RedisAdapter: redisOptions.replyMapping "resp3" requires redisOptions.protocol 3');
    }

    return {
        ...rest,
        protocol: resolvedProtocol,
        ...(replyMapping === undefined ? {} : { replyMapping }),
        ...(connectionName !== undefined && redisOptions?.connectionName === undefined ? { connectionName } : {}),
    };
}

/** Describe how ioredis maps replies for the selected wire protocol. */
export function redisReplyContext(redisOptions: RedisConstructorOptions): RedisReplyContext {
    return {
        protocol: redisOptions.protocol,
        replyMapping: redisOptions.protocol === 3 ? (redisOptions.replyMapping ?? "legacy") : "legacy",
    };
}

function replyError(command: string, context: RedisReplyContext, detail: string): RedisReplyShapeError {
    return new RedisReplyShapeError({ command, context, detail });
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeString(value: unknown, command: string, context: RedisReplyContext, path: string): string {
    if (typeof value !== "string") {
        throw replyError(command, context, `${path} must be a string`);
    }
    return value;
}

function normalizeNumber(value: unknown, command: string, context: RedisReplyContext, path: string): number {
    const numberValue = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    if (!Number.isFinite(numberValue)) {
        throw replyError(command, context, `${path} must be a finite number`);
    }
    return numberValue;
}

function normalizeFields(value: unknown, command: string, context: RedisReplyContext, path: string): string[] {
    if (Array.isArray(value)) {
        if (value.length % 2 !== 0) {
            throw replyError(command, context, `${path} must contain field/value pairs`);
        }
        return value.map((item, index) => normalizeString(item, command, context, `${path}[${index}]`));
    }

    if (isRecord(value)) {
        return Object.entries(value).flatMap(([field, fieldValue]) => [field, normalizeString(fieldValue, command, context, `${path}.${field}`)]);
    }

    throw replyError(command, context, `${path} must be a field/value array or object`);
}

function normalizeStreamEntry(value: unknown, command: string, context: RedisReplyContext, path: string): RedisStreamEntry {
    if (!Array.isArray(value) || value.length !== 2) {
        throw replyError(command, context, `${path} must be [id, fields]`);
    }
    return [normalizeString(value[0], command, context, `${path}[0]`), normalizeFields(value[1], command, context, `${path}[1]`)];
}

function normalizeStreamEntries(value: unknown, command: string, context: RedisReplyContext, path: string): RedisStreamEntry[] {
    if (Array.isArray(value)) {
        return value.map((entry, index) => normalizeStreamEntry(entry, command, context, `${path}[${index}]`));
    }

    if (isRecord(value)) {
        return Object.entries(value).map(([id, fields]) => [id, normalizeFields(fields, command, context, `${path}.${id}`)]);
    }

    throw replyError(command, context, `${path} must be a stream-entry array or object`);
}

function normalizeStreamPair(stream: unknown, entries: unknown, command: string, context: RedisReplyContext, path: string): [string, RedisStreamEntry[]] {
    return [normalizeString(stream, command, context, `${path}.stream`), normalizeStreamEntries(entries, command, context, `${path}.entries`)];
}

/** Normalize XREADGROUP across RESP2, RESP3 legacy, and RESP3 native mapping. */
export function normalizeXReadGroupReply(value: unknown, context: RedisReplyContext): RedisStreamReadResult | null {
    const command = "XREADGROUP";
    if (value === null) {
        return null;
    }

    if (isRecord(value)) {
        return Object.entries(value).map(([stream, entries], index) => normalizeStreamPair(stream, entries, command, context, `reply[${index}]`));
    }

    if (!Array.isArray(value)) {
        throw replyError(command, context, "reply must be an array, object, or null");
    }

    if (value.length === 0) {
        return [];
    }

    if (Array.isArray(value[0])) {
        return value.map((pair, index) => {
            if (!Array.isArray(pair) || pair.length !== 2) {
                throw replyError(command, context, `reply[${index}] must be [stream, entries]`);
            }
            return normalizeStreamPair(pair[0], pair[1], command, context, `reply[${index}]`);
        });
    }

    if (value.length % 2 !== 0) {
        throw replyError(command, context, "flat RESP3 legacy reply must contain stream/entries pairs");
    }

    const result: RedisStreamReadResult = [];
    for (let index = 0; index < value.length; index += 2) {
        result.push(normalizeStreamPair(value[index], value[index + 1], command, context, `reply[${index / 2}]`));
    }
    return result;
}

/** Normalize XAUTOCLAIM, including Redis 6.2 replies without deleted ids. */
export function normalizeXAutoClaimReply(value: unknown, context: RedisReplyContext): RedisAutoClaimResult | null {
    const command = "XAUTOCLAIM";
    if (value === null) {
        return null;
    }
    if (!Array.isArray(value) || value.length < 2 || value.length > 3) {
        throw replyError(command, context, "reply must be [next-start-id, entries, deleted-ids?]");
    }

    const deletedIdsValue = value[2] ?? [];
    if (!Array.isArray(deletedIdsValue)) {
        throw replyError(command, context, "deleted ids must be an array");
    }

    return [
        normalizeString(value[0], command, context, "reply[0]"),
        normalizeStreamEntries(value[1], command, context, "reply[1]"),
        deletedIdsValue.map((id, index) => normalizeString(id, command, context, `reply[2][${index}]`)),
    ];
}

/** Normalize the detailed XPENDING form used to recover delivery counts. */
export function normalizeXPendingReply(value: unknown, context: RedisReplyContext): RedisPendingDetail[] | null {
    const command = "XPENDING";
    if (value === null) {
        return null;
    }
    if (!Array.isArray(value)) {
        throw replyError(command, context, "reply must be an array or null");
    }

    return value.map((entry, index) => {
        if (!Array.isArray(entry) || entry.length !== 4) {
            throw replyError(command, context, `reply[${index}] must be [id, consumer, idle-ms, delivery-count]`);
        }
        return [
            normalizeString(entry[0], command, context, `reply[${index}][0]`),
            normalizeString(entry[1], command, context, `reply[${index}][1]`),
            normalizeNumber(entry[2], command, context, `reply[${index}][2]`),
            normalizeNumber(entry[3], command, context, `reply[${index}][3]`),
        ];
    });
}
