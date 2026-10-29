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
// Positive: pass-through of string settings and HTTP health flag
// ---------------------------------------------------------------------------

describe("parseEnvConfig() LISTEN and HTTP health settings", () => {
    it("should take LISTEN and HTTP_HEALTH_PATH from the input instead of the defaults", () => {
        const config = parseEnvConfig({ LISTEN: "127.0.0.1", HTTP_HEALTH_PATH: "/ping" });
        assert.equal(config.LISTEN, "127.0.0.1");
        assert.equal(config.HTTP_HEALTH_PATH, "/ping");
    });

    it("should treat a variable that is present but undefined as unset", () => {
        const config = parseEnvConfig({ PORT: undefined, LISTEN: undefined, HTTP_HEALTH_ENABLED: undefined });
        assert.equal(config.PORT, 5000);
        assert.equal(config.LISTEN, "0.0.0.0");
        assert.equal(config.HTTP_HEALTH_ENABLED, false);
    });

    // Configuration guide: boolean variables accept "true", "false", "1", "0", "yes" and "no".
    for (const [value, expected] of [
        ["true", true],
        ["1", true],
        ["yes", true],
        ["false", false],
        ["0", false],
        ["no", false],
    ] as const) {
        it(`should parse HTTP_HEALTH_ENABLED="${value}" to ${expected}`, () => {
            assert.equal(parseEnvConfig({ HTTP_HEALTH_ENABLED: value }).HTTP_HEALTH_ENABLED, expected);
        });
    }

    it("should reject a boolean variable that is not one of the documented spellings, naming the variable", () => {
        for (const name of ["HTTP_HEALTH_ENABLED", "GRACEFUL_SHUTDOWN_ENABLED"]) {
            assert.throws(
                () => parseEnvConfig({ [name]: "maybe" }),
                (err) => err instanceof ZodError && err.issues.length === 1 && err.issues[0]?.path.join(".") === name,
                name,
            );
        }
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
    it("should return { success: true, data } holding the parsed input and the defaults for valid env", () => {
        // Non-default values for the fields that are converted, so that
        // "parsed the input" differs from "returned the defaults".
        const result = safeParseEnvConfig({
            PORT: "8080",
            LOG_LEVEL: "debug",
            NODE_ENV: "production",
            HTTP_HEALTH_ENABLED: "true",
            GRACEFUL_SHUTDOWN_ENABLED: "false",
            GRACEFUL_SHUTDOWN_TIMEOUT_MS: "1500",
        });
        assert.equal(result.success, true);
        assert.ok("data" in result);
        assert.equal(result.data.PORT, 8080);
        assert.equal(result.data.LOG_LEVEL, "debug");
        assert.equal(result.data.NODE_ENV, "production");
        assert.equal(result.data.HTTP_HEALTH_ENABLED, true);
        assert.equal(result.data.GRACEFUL_SHUTDOWN_ENABLED, false);
        assert.equal(result.data.GRACEFUL_SHUTDOWN_TIMEOUT_MS, 1500);
        // Fields that were not given keep their documented defaults.
        assert.equal(result.data.LISTEN, "0.0.0.0");
        assert.equal(result.data.LOG_FORMAT, "json");
        assert.equal(result.data.LOG_BACKEND, "otel");
        assert.equal(result.data.HTTP_HEALTH_PATH, "/healthz");
    });

    it("should return { success: false, error } without throwing, naming exactly the invalid field", () => {
        const result = safeParseEnvConfig({ PORT: "not-a-number", LOG_LEVEL: "debug" });
        assert.equal(result.success, false);
        assert.ok("error" in result);
        assert.ok(result.error instanceof ZodError);
        assert.deepEqual(
            result.error.issues.map((issue) => issue.path.join(".")),
            ["PORT"],
        );
    });

    it("should report every invalid field, not only the first", () => {
        const result = safeParseEnvConfig({ PORT: "0", LOG_LEVEL: "trace", NODE_ENV: "staging" });
        assert.equal(result.success, false);
        assert.ok("error" in result);
        assert.deepEqual(
            result.error.issues.map((issue) => issue.path.join(".")).sort(),
            ["LOG_LEVEL", "NODE_ENV", "PORT"],
        );
    });
});

// ---------------------------------------------------------------------------
// Positive: process.env fallback
// ---------------------------------------------------------------------------

describe("parseEnvConfig() process.env fallback", () => {
    it("should use process.env when no argument is passed", () => {
        // Save and clear schema-relevant env vars to avoid host interference
        const saved: Record<string, string | undefined> = {};
        const keysToClean = ["PORT", "LISTEN", "LOG_LEVEL", "LOG_FORMAT", "LOG_BACKEND", "NODE_ENV",
            "HTTP_HEALTH_ENABLED", "HTTP_HEALTH_PATH",
            "GRACEFUL_SHUTDOWN_ENABLED", "GRACEFUL_SHUTDOWN_TIMEOUT_MS",
            "OTEL_SERVICE_NAME", "OTEL_EXPORTER_OTLP_ENDPOINT"];
        for (const key of keysToClean) {
            saved[key] = process.env[key];
            delete process.env[key];
        }
        try {
            // Values that differ from every default: they can only come from process.env.
            process.env.PORT = "1234";
            process.env.LOG_LEVEL = "warn";
            process.env.HTTP_HEALTH_ENABLED = "true";
            const config = parseEnvConfig();
            assert.equal(config.PORT, 1234);
            assert.equal(config.LOG_LEVEL, "warn");
            assert.equal(config.HTTP_HEALTH_ENABLED, true);
            // Untouched variables keep their defaults.
            assert.equal(config.LISTEN, "0.0.0.0");
        } finally {
            // Restore original env vars
            for (const key of keysToClean) {
                if (saved[key] !== undefined) process.env[key] = saved[key];
                else delete process.env[key];
            }
        }
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

    // 65536 is the first value above the documented 1--65535 range; 70000 is well above it.
    for (const port of ["65536", "70000"]) {
        it(`should reject PORT=${port} (above max=65535), naming PORT`, () => {
            assert.throws(
                () => parseEnvConfig({ PORT: port }),
                (err) => err instanceof ZodError && err.issues.length === 1 && err.issues[0]?.path.join(".") === "PORT",
            );
        });
    }

    it("should reject an empty PORT (it would otherwise coerce to 0), naming PORT", () => {
        assert.throws(
            () => parseEnvConfig({ PORT: "" }),
            (err) => err instanceof ZodError && err.issues.length === 1 && err.issues[0]?.path.join(".") === "PORT",
        );
    });

    // A port is a whole number: a fractional value would otherwise pass the schema and fail
    // later inside the network layer with an error that does not name PORT.
    for (const port of ["80.5", "1.5", "65534.5", "1000.000001"]) {
        it(`should reject the fractional PORT=${port}, naming PORT and the integer requirement`, () => {
            assert.throws(
                () => parseEnvConfig({ PORT: port }),
                (err) =>
                    err instanceof ZodError &&
                    err.issues.length === 1 &&
                    err.issues[0]?.path.join(".") === "PORT" &&
                    /int/i.test(err.issues[0]?.message ?? ""),
            );
        });
    }

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

    // 300001 is the first value above the documented 0--300000 range.
    for (const timeout of ["300001", "999999"]) {
        it(`should reject ${timeout} (above max=300000), naming GRACEFUL_SHUTDOWN_TIMEOUT_MS`, () => {
            assert.throws(
                () => parseEnvConfig({ GRACEFUL_SHUTDOWN_TIMEOUT_MS: timeout }),
                (err) => err instanceof ZodError && err.issues.length === 1 && err.issues[0]?.path.join(".") === "GRACEFUL_SHUTDOWN_TIMEOUT_MS",
            );
        });
    }
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

// ---------------------------------------------------------------------------
// PORT: only decimal digits. `Number()` would also read hex, exponent, signed
// and padded forms, each as a different port than a reader of the value expects.
// ---------------------------------------------------------------------------

describe("parseEnvConfig() PORT notation", () => {
    for (const port of ["0x50", "0X50", "1e3", "+80", "-80", " 80", "80 ", "8_0", "0b101", "٨٠"]) {
        it(`should reject PORT=${JSON.stringify(port)}, naming PORT and the decimal-digit rule`, () => {
            assert.throws(
                () => parseEnvConfig({ PORT: port }),
                (err) => err instanceof ZodError && err.issues.length === 1 && err.issues[0]?.path.join(".") === "PORT" && /decimal digits/.test(err.issues[0]?.message ?? ""),
            );
        });
    }

    // Leading zeros stay decimal: "08080" is 8080, never octal.
    for (const [port, expected] of [
        ["08080", 8080],
        ["0080", 80],
        ["1", 1],
        ["65535", 65_535],
    ] as const) {
        it(`should read PORT=${JSON.stringify(port)} as the decimal ${expected}`, () => {
            assert.strictEqual(parseEnvConfig({ PORT: port }).PORT, expected);
        });
    }

    it("should still apply the range to a digits-only value", () => {
        assert.throws(
            () => parseEnvConfig({ PORT: "000" }),
            (err) => err instanceof ZodError && err.issues[0]?.path.join(".") === "PORT",
        );
        assert.throws(
            () => parseEnvConfig({ PORT: "99999999999999999999" }),
            (err) => err instanceof ZodError && err.issues[0]?.path.join(".") === "PORT",
        );
    });
});

// ---------------------------------------------------------------------------
// OTEL_EXPORTER_OTLP_ENDPOINT: an http(s) URL. A bare host:port parses as a URL
// whose scheme is the host name, and an exporter given it fails far from here.
// ---------------------------------------------------------------------------

describe("parseEnvConfig() OTEL_EXPORTER_OTLP_ENDPOINT scheme", () => {
    for (const endpoint of ["localhost:4318", "ftp://collector", "ws://collector:4318", "file:///etc/passwd", "collector.example:4318", "not a url", "http://", "//collector:4318"]) {
        it(`should reject ${JSON.stringify(endpoint)}, naming OTEL_EXPORTER_OTLP_ENDPOINT`, () => {
            assert.throws(
                () => parseEnvConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }),
                (err) => err instanceof ZodError && err.issues.length === 1 && err.issues[0]?.path.join(".") === "OTEL_EXPORTER_OTLP_ENDPOINT",
            );
        });
    }

    for (const endpoint of ["http://localhost:4318", "https://collector.example:4318", "https://collector.example/v1/traces", "http://10.0.0.5:4317"]) {
        it(`should accept ${JSON.stringify(endpoint)} unchanged`, () => {
            assert.strictEqual(parseEnvConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: endpoint }).OTEL_EXPORTER_OTLP_ENDPOINT, endpoint);
        });
    }
});

// ---------------------------------------------------------------------------
// An empty OTEL_* variable is the same as an unset one, the rule the
// OpenTelemetry SDK applies to its own environment variables.
// ---------------------------------------------------------------------------

describe("parseEnvConfig() empty OTEL_* variables", () => {
    it("should read an empty OTEL_SERVICE_NAME as unset", () => {
        assert.strictEqual(parseEnvConfig({ OTEL_SERVICE_NAME: "" }).OTEL_SERVICE_NAME, undefined);
    });

    it("should read an empty OTEL_EXPORTER_OTLP_ENDPOINT as unset instead of rejecting it", () => {
        assert.strictEqual(parseEnvConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: "" }).OTEL_EXPORTER_OTLP_ENDPOINT, undefined);
    });

    it("should keep a whitespace-only name as given: only the empty string is unset", () => {
        assert.strictEqual(parseEnvConfig({ OTEL_SERVICE_NAME: " " }).OTEL_SERVICE_NAME, " ");
    });

    it("should still reject a whitespace-only endpoint", () => {
        assert.throws(
            () => parseEnvConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: " " }),
            (err) => err instanceof ZodError && err.issues[0]?.path.join(".") === "OTEL_EXPORTER_OTLP_ENDPOINT",
        );
    });
});
