/**
 * Configuration module
 *
 * Provides type-safe environment configuration validation
 * using Zod schemas. Follows 12-Factor App principles.
 *
 * @example
 * ```typescript
 * import { parseEnvConfig, type ConnectumEnv } from '@connectum/core/config';
 *
 * // Parse environment with defaults
 * const config = parseEnvConfig();
 *
 * // Use validated config
 * console.log(`Starting server on port ${config.PORT}`);
 * console.log(`Log level: ${config.LOG_LEVEL}`);
 * console.log(`HTTP health enabled: ${config.HTTP_HEALTH_ENABLED}`);
 * ```
 *
 * @module @connectum/core/config
 */

export {
    ConnectumEnvSchema,
    LogLevelSchema,
    LogFormatSchema,
    LoggerBackendSchema,
    NodeEnvSchema,
    BooleanFromStringSchema,
    parseEnvConfig,
    safeParseEnvConfig,
    type ConnectumEnv,
} from "./envSchema.ts";
