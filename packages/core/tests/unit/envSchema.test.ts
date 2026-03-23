/**
 * Unit tests for environment configuration schema (envSchema.ts)
 *
 * Validates Zod-based environment parsing: defaults, coercion,
 * boolean transforms, safe parsing, and error cases.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ZodError } from "zod";
import {
    BooleanFromStringSchema,
    parseEnvConfig,
    safeParseEnvConfig,
} from "../../src/config/envSchema.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal env that passes validation (all fields use defaults). */
const EMPTY_ENV: Record<string, string | undefined> = {};

// ---------------------------------------------------------------------------
// Positive: defaults
// ---------------------------------------------------------------------------

describe("parseEnvConfig() defaults", () => {
    it("should return defaults when given empty object", () => {
        const config = parseEnvConfig(EMPTY_ENV);

        assert.equal(config.PORT, 5000);
        assert.equal(config.LISTEN, "0.0.0.0");
        assert.equal(config.LOG_LEVEL, "info");
        assert.equal(config.LOG_FORMAT, "json");
        assert.equal(config.LOG_BACKEND, "otel");
        assert.equal(config.NODE_ENV, "development");
        assert.equal(config.HTTP_HEALTH_ENABLED, false);
        assert.equal(config.HTTP_HEALTH_PATH, "/healthz");
        assert.equal(config.OTEL_SERVICE_NAME, undefined);
        assert.equal(config.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
        assert.equal(config.GRACEFUL_SHUTDOWN_ENABLED, true);
        assert.equal(config.GRACEFUL_SHUTDOWN_TIMEOUT_MS, 30000);
    });
});

// ---------------------------------------------------------------------------
// Positive: PORT
// ---------------------------------------------------------------------------

describe("parseEnvConfig() PORT", () => {
    it("should parse valid PORT string to number", () => {
        const config = parseEnvConfig({ PORT: "8080" });
        assert.equal(config.PORT, 8080);
    });

    it("should accept minimum port 1", () => {
        const config = parseEnvConfig({ PORT: "1" });
        assert.equal(config.PORT, 1);
    });

    it("should accept maximum port 65535", () => {
        const config = parseEnvConfig({ PORT: "65535" });
        assert.equal(config.PORT, 65535);
    });
});

// ---------------------------------------------------------------------------
// Positive: LOG_LEVEL variants
// ---------------------------------------------------------------------------

describe("parseEnvConfig() LOG_LEVEL", () => {
    const validLevels = ["debug", "info", "warn", "error"] as const;

    for (const level of validLevels) {
        it(`should accept LOG_LEVEL="${level}"`, () => {
            const config = parseEnvConfig({ LOG_LEVEL: level });
            assert.equal(config.LOG_LEVEL, level);
        });
    }
});

// ---------------------------------------------------------------------------
// Positive: LOG_FORMAT variants
// ---------------------------------------------------------------------------

describe("parseEnvConfig() LOG_FORMAT", () => {
    const validFormats = ["json", "pretty"] as const;

    for (const format of validFormats) {
        it(`should accept LOG_FORMAT="${format}"`, () => {
            const config = parseEnvConfig({ LOG_FORMAT: format });
            assert.equal(config.LOG_FORMAT, format);
        });
    }
});

// ---------------------------------------------------------------------------
// Positive: LOG_BACKEND variants
// ---------------------------------------------------------------------------

describe("parseEnvConfig() LOG_BACKEND", () => {
    const validBackends = ["otel", "pino", "console"] as const;

    for (const backend of validBackends) {
        it(`should accept LOG_BACKEND="${backend}"`, () => {
            const config = parseEnvConfig({ LOG_BACKEND: backend });
            assert.equal(config.LOG_BACKEND, backend);
        });
    }
});

// ---------------------------------------------------------------------------
// Positive: NODE_ENV variants
// ---------------------------------------------------------------------------

describe("parseEnvConfig() NODE_ENV", () => {
    const validEnvs = ["development", "production", "test"] as const;

    for (const env of validEnvs) {
        it(`should accept NODE_ENV="${env}"`, () => {
            const config = parseEnvConfig({ NODE_ENV: env });
            assert.equal(config.NODE_ENV, env);
        });
    }
});

// ---------------------------------------------------------------------------
// Positive: BooleanFromStringSchema
// ---------------------------------------------------------------------------

describe("BooleanFromStringSchema", () => {
    const truthyValues = ["true", "1", "yes"] as const;
    const falsyValues = ["false", "0", "no"] as const;

    for (const value of truthyValues) {
        it(`should transform "${value}" to true`, () => {
            assert.equal(BooleanFromStringSchema.parse(value), true);
        });
    }

    for (const value of falsyValues) {
        it(`should transform "${value}" to false`, () => {
            assert.equal(BooleanFromStringSchema.parse(value), false);
        });
    }

    it("should default to false when undefined", () => {
        assert.equal(BooleanFromStringSchema.parse(undefined), false);
    });
});

// ---------------------------------------------------------------------------
// Positive: GRACEFUL_SHUTDOWN_ENABLED as boolean
// ---------------------------------------------------------------------------

describe("parseEnvConfig() GRACEFUL_SHUTDOWN_ENABLED", () => {
    it("should parse 'true' to boolean true", () => {
        const config = parseEnvConfig({ GRACEFUL_SHUTDOWN_ENABLED: "true" });
        assert.equal(config.GRACEFUL_SHUTDOWN_ENABLED, true);
    });

    it("should parse 'false' to boolean false", () => {
        const config = parseEnvConfig({ GRACEFUL_SHUTDOWN_ENABLED: "false" });
        assert.equal(config.GRACEFUL_SHUTDOWN_ENABLED, false);
    });

    it("should parse '1' to boolean true", () => {
        const config = parseEnvConfig({ GRACEFUL_SHUTDOWN_ENABLED: "1" });
        assert.equal(config.GRACEFUL_SHUTDOWN_ENABLED, true);
    });

    it("should parse '0' to boolean false", () => {
        const config = parseEnvConfig({ GRACEFUL_SHUTDOWN_ENABLED: "0" });
        assert.equal(config.GRACEFUL_SHUTDOWN_ENABLED, false);
    });

    it("should parse 'yes' to boolean true", () => {
        const config = parseEnvConfig({ GRACEFUL_SHUTDOWN_ENABLED: "yes" });
        assert.equal(config.GRACEFUL_SHUTDOWN_ENABLED, true);
    });

    it("should parse 'no' to boolean false", () => {
        const config = parseEnvConfig({ GRACEFUL_SHUTDOWN_ENABLED: "no" });
        assert.equal(config.GRACEFUL_SHUTDOWN_ENABLED, false);
    });

    it("should default to true when not provided", () => {
        const config = parseEnvConfig(EMPTY_ENV);
        assert.equal(config.GRACEFUL_SHUTDOWN_ENABLED, true);
    });
});

// ---------------------------------------------------------------------------
// Positive: GRACEFUL_SHUTDOWN_TIMEOUT_MS coercion
// ---------------------------------------------------------------------------

describe("parseEnvConfig() GRACEFUL_SHUTDOWN_TIMEOUT_MS", () => {
    it("should coerce string to number", () => {
        const config = parseEnvConfig({ GRACEFUL_SHUTDOWN_TIMEOUT_MS: "5000" });
        assert.equal(config.GRACEFUL_SHUTDOWN_TIMEOUT_MS, 5000);
    });

    it("should accept 0 (minimum)", () => {
        const config = parseEnvConfig({ GRACEFUL_SHUTDOWN_TIMEOUT_MS: "0" });
        assert.equal(config.GRACEFUL_SHUTDOWN_TIMEOUT_MS, 0);
    });

    it("should accept 300000 (maximum)", () => {
        const config = parseEnvConfig({ GRACEFUL_SHUTDOWN_TIMEOUT_MS: "300000" });
        assert.equal(config.GRACEFUL_SHUTDOWN_TIMEOUT_MS, 300000);
    });
});

// ---------------------------------------------------------------------------
// Positive: optional fields
// ---------------------------------------------------------------------------

describe("parseEnvConfig() optional fields", () => {
    it("should accept OTEL_SERVICE_NAME when provided", () => {
        const config = parseEnvConfig({ OTEL_SERVICE_NAME: "my-service" });
        assert.equal(config.OTEL_SERVICE_NAME, "my-service");
    });

    it("should leave OTEL_SERVICE_NAME undefined when not provided", () => {
        const config = parseEnvConfig(EMPTY_ENV);
        assert.equal(config.OTEL_SERVICE_NAME, undefined);
    });

    it("should accept valid OTEL_EXPORTER_OTLP_ENDPOINT", () => {
        const config = parseEnvConfig({
            OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4317",
        });
        assert.equal(config.OTEL_EXPORTER_OTLP_ENDPOINT, "http://localhost:4317");
    });

    it("should leave OTEL_EXPORTER_OTLP_ENDPOINT undefined when not provided", () => {
        const config = parseEnvConfig(EMPTY_ENV);
        assert.equal(config.OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
    });
});

// ---------------------------------------------------------------------------
// Positive: safeParseEnvConfig()
// ---------------------------------------------------------------------------

describe("safeParseEnvConfig()", () => {
    it("should return { success: true, data } for valid env", () => {
        const result = safeParseEnvConfig(EMPTY_ENV);
        assert.equal(result.success, true);
        assert.ok("data" in result);
        assert.equal(result.data.PORT, 5000);
    });

    it("should return { success: false, error } without throwing for invalid env", () => {
        const result = safeParseEnvConfig({ PORT: "not-a-number" });
        assert.equal(result.success, false);
        assert.ok("error" in result);
        assert.ok(result.error instanceof ZodError);
    });
});

// ---------------------------------------------------------------------------
// Positive: process.env fallback
// ---------------------------------------------------------------------------

describe("parseEnvConfig() process.env fallback", () => {
    it("should use process.env when no argument is passed", () => {
        // parseEnvConfig() without args should not throw -- process.env
        // contains string values and Zod defaults handle missing keys.
        const config = parseEnvConfig();
        assert.ok(typeof config.PORT === "number");
        assert.ok(typeof config.LOG_LEVEL === "string");
    });
});

// ---------------------------------------------------------------------------
// Negative: PORT validation
// ---------------------------------------------------------------------------

describe("parseEnvConfig() PORT validation errors", () => {
    it("should reject PORT=0 (below min=1)", () => {
        assert.throws(
            () => parseEnvConfig({ PORT: "0" }),
            (err) => err instanceof ZodError,
        );
    });

    it("should reject PORT=70000 (above max=65535)", () => {
        assert.throws(
            () => parseEnvConfig({ PORT: "70000" }),
            (err) => err instanceof ZodError,
        );
    });

    it("should reject PORT='not-a-number'", () => {
        assert.throws(
            () => parseEnvConfig({ PORT: "not-a-number" }),
            (err) => err instanceof ZodError,
        );
    });
});

// ---------------------------------------------------------------------------
// Negative: LOG_LEVEL validation
// ---------------------------------------------------------------------------

describe("parseEnvConfig() LOG_LEVEL validation errors", () => {
    it("should reject LOG_LEVEL='trace'", () => {
        assert.throws(
            () => parseEnvConfig({ LOG_LEVEL: "trace" }),
            (err) => err instanceof ZodError,
        );
    });
});

// ---------------------------------------------------------------------------
// Negative: NODE_ENV validation
// ---------------------------------------------------------------------------

describe("parseEnvConfig() NODE_ENV validation errors", () => {
    it("should reject NODE_ENV='staging'", () => {
        assert.throws(
            () => parseEnvConfig({ NODE_ENV: "staging" }),
            (err) => err instanceof ZodError,
        );
    });
});

// ---------------------------------------------------------------------------
// Negative: OTEL_EXPORTER_OTLP_ENDPOINT validation
// ---------------------------------------------------------------------------

describe("parseEnvConfig() OTEL_EXPORTER_OTLP_ENDPOINT validation errors", () => {
    it("should reject invalid URL", () => {
        assert.throws(
            () => parseEnvConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "not-a-url" }),
            (err) => err instanceof ZodError,
        );
    });
});

// ---------------------------------------------------------------------------
// Negative: GRACEFUL_SHUTDOWN_TIMEOUT_MS validation
// ---------------------------------------------------------------------------

describe("parseEnvConfig() GRACEFUL_SHUTDOWN_TIMEOUT_MS validation errors", () => {
    it("should reject -1 (below min=0)", () => {
        assert.throws(
            () => parseEnvConfig({ GRACEFUL_SHUTDOWN_TIMEOUT_MS: "-1" }),
            (err) => err instanceof ZodError,
        );
    });

    it("should reject 999999 (above max=300000)", () => {
        assert.throws(
            () => parseEnvConfig({ GRACEFUL_SHUTDOWN_TIMEOUT_MS: "999999" }),
            (err) => err instanceof ZodError,
        );
    });
});

// ---------------------------------------------------------------------------
// Negative: BooleanFromStringSchema validation
// ---------------------------------------------------------------------------

describe("BooleanFromStringSchema validation errors", () => {
    it("should reject 'maybe'", () => {
        assert.throws(
            () => BooleanFromStringSchema.parse("maybe"),
            (err) => err instanceof ZodError,
        );
    });

    it("should reject 'TRUE' (case-sensitive)", () => {
        assert.throws(
            () => BooleanFromStringSchema.parse("TRUE"),
            (err) => err instanceof ZodError,
        );
    });
});
