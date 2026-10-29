/**
 * Environment configuration validation with Zod
 *
 * Provides type-safe configuration from environment variables
 * following 12-Factor App principles.
 *
 * @module config
 */

import { z } from "zod";

/**
 * An empty environment variable is the same as an unset one (OpenTelemetry SDK
 * rule for its `OTEL_*` variables), which orchestrators rely on when they pass
 * a blank value for a variable the operator did not set.
 */
const emptyAsUnset = (value: unknown): unknown => (value === "" ? undefined : value);

/**
 * Log level schema with validation
 */
export const LogLevelSchema = z.enum(["debug", "info", "warn", "error"]).default("info");

/**
 * Log format schema
 */
export const LogFormatSchema = z.enum(["json", "pretty"]).default("json");

/**
 * Logger backend schema
 */
export const LoggerBackendSchema = z.enum(["otel", "pino", "console"]).default("otel");

/**
 * Node environment schema
 */
export const NodeEnvSchema = z.enum(["development", "production", "test"]).default("development");

/**
 * Boolean from string schema (for ENV variables)
 */
export const BooleanFromStringSchema = z
    .enum(["true", "false", "1", "0", "yes", "no"])
    .default("false")
    .transform((v) => v === "true" || v === "1" || v === "yes");

/**
 * Connectum environment configuration schema
 *
 * All environment variables with their defaults and validation.
 * Based on 12-Factor App configuration principles.
 *
 * @example
 * ```typescript
 * const config = ConnectumEnvSchema.parse(process.env);
 * console.log(config.PORT); // 5000 (default)
 * console.log(config.LOG_LEVEL); // 'info' (default)
 * ```
 */
export const ConnectumEnvSchema = z.object({
    /**
     * Server port: a whole number from 1 to 65535 written in decimal digits. A
     * fraction, or a form `Number()` would read (`0x50`, `1e3`, `+80`, padded with
     * spaces), is rejected here instead of being read as another port or failing
     * later inside the network layer.
     * @default 5000
     */
    PORT: z.string().regex(/^\d+$/, "PORT must be an integer from 1 to 65535 written in decimal digits").transform(Number).pipe(z.number().int().min(1).max(65535)).default(5000),

    /**
     * Listen address
     * @default '0.0.0.0'
     */
    LISTEN: z.string().default("0.0.0.0"),

    /**
     * Log level
     * @default 'info'
     */
    LOG_LEVEL: LogLevelSchema,

    /**
     * Log format (json for production, pretty for development)
     * @default 'json'
     */
    LOG_FORMAT: LogFormatSchema,

    /**
     * Logger backend
     * @default 'otel'
     */
    LOG_BACKEND: LoggerBackendSchema,

    /**
     * Node environment
     * @default 'development'
     */
    NODE_ENV: NodeEnvSchema,

    /**
     * Enable HTTP health endpoints (/healthz, /readyz)
     * When disabled, only gRPC healthcheck is available
     * @default false
     */
    HTTP_HEALTH_ENABLED: BooleanFromStringSchema,

    /**
     * HTTP health endpoint path
     * @default '/healthz'
     */
    HTTP_HEALTH_PATH: z.string().default("/healthz"),

    /**
     * Optional OpenTelemetry service name. The core parser leaves it undefined
     * when absent or empty (the OpenTelemetry SDK reads an empty value of an
     * environment variable as unset); provider defaults belong to the telemetry
     * package.
     */
    OTEL_SERVICE_NAME: z.preprocess(emptyAsUnset, z.string().optional()),

    /**
     * OpenTelemetry exporter endpoint: an absolute `http:` or `https:` URL. A bare
     * `host:port` such as `localhost:4318` parses as a URL with the scheme
     * `localhost:`, so the scheme is checked explicitly. An empty value is read as unset.
     */
    OTEL_EXPORTER_OTLP_ENDPOINT: z.preprocess(emptyAsUnset, z.url({ protocol: /^https?$/ }).optional()),

    /**
     * Enable graceful shutdown
     * @default true
     */
    GRACEFUL_SHUTDOWN_ENABLED: z
        .enum(["true", "false", "1", "0", "yes", "no"])
        .default("true")
        .transform((v) => v === "true" || v === "1" || v === "yes"),

    /**
     * Graceful shutdown timeout in milliseconds: a whole number from 0 to
     * 300000, the same kind of value `createServer({ shutdown: { timeout } })`
     * accepts (a fraction is rejected here, naming this variable, instead of at
     * server creation)
     * @default 30000
     */
    GRACEFUL_SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(0).max(300000).default(30000),
});

/**
 * Connectum environment configuration type
 */
export type ConnectumEnv = z.infer<typeof ConnectumEnvSchema>;

/**
 * Parse and validate environment configuration
 *
 * @example
 * ```typescript
 * const config = parseEnvConfig();
 * // or with custom env
 * const config = parseEnvConfig({ PORT: '8080' });
 * ```
 */
export function parseEnvConfig(env: Record<string, string | undefined> = process.env): ConnectumEnv {
    return ConnectumEnvSchema.parse(env);
}

/**
 * Safely parse environment configuration (returns result object)
 *
 * @example
 * ```typescript
 * const result = safeParseEnvConfig();
 * if (result.success) {
 *   console.log(result.data.PORT);
 * } else {
 *   console.error(result.error.format());
 * }
 * ```
 */
export function safeParseEnvConfig(env: Record<string, string | undefined> = process.env) {
    return ConnectumEnvSchema.safeParse(env);
}
