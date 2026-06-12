/**
 * TransportValidation unit tests
 *
 * Validation matrix: mode (error/warn/off) × transport (plaintext-h1 vs
 * streaming-capable) × method kinds. DescFile registry entries are mocked
 * structurally (services[].methods[].methodKind — the protobuf-es
 * descriptor shape).
 */

import assert from "node:assert";
import { describe, it, mock } from "node:test";
import type { DescFile } from "@bufbuild/protobuf";
import { collectStreamingMethods, EffectiveTransport, formatTransportValidationMessage, resolveEffectiveTransport, TRANSPORT_VALIDATION_ERROR_CODE, TransportValidationError, validateTransport } from "../../src/TransportValidation.ts";

/** Structural mock of a DescFile with the given service methods. */
function mockDescFile(service: string, methods: Array<{ name: string; methodKind: string }>): DescFile {
    return {
        services: [{ typeName: service, methods }],
    } as unknown as DescFile;
}

const UNARY_ONLY = mockDescFile("acme.v1.UnaryService", [
    { name: "Get", methodKind: "unary" },
    { name: "Watch", methodKind: "server_streaming" },
]);

const WITH_BIDI = mockDescFile("acme.v1.ScannerService", [
    { name: "Get", methodKind: "unary" },
    { name: "StreamCodes", methodKind: "bidi_streaming" },
]);

const WITH_CLIENT_STREAM = mockDescFile("acme.v1.UploadService", [{ name: "Upload", methodKind: "client_streaming" }]);

describe("collectStreamingMethods", () => {
    it("collects only bidi — unary, server-streaming, and client-streaming work over HTTP/1.1 per the Connect protocol", () => {
        const methods = collectStreamingMethods([UNARY_ONLY, WITH_BIDI, WITH_CLIENT_STREAM]);

        assert.deepStrictEqual(methods, [{ service: "acme.v1.ScannerService", method: "StreamCodes", kind: "bidi_streaming" }]);
    });

    it("returns empty for unary/server-streaming-only registry", () => {
        assert.deepStrictEqual(collectStreamingMethods([UNARY_ONLY]), []);
    });
});

describe("resolveEffectiveTransport", () => {
    it("maps tls × allowHTTP1 to the four transports", () => {
        assert.strictEqual(resolveEffectiveTransport({ hasTls: false, allowHTTP1: true }), EffectiveTransport.PLAINTEXT_H1);
        assert.strictEqual(resolveEffectiveTransport({ hasTls: false }), EffectiveTransport.PLAINTEXT_H1); // allowHTTP1 defaults true
        assert.strictEqual(resolveEffectiveTransport({ hasTls: false, allowHTTP1: false }), EffectiveTransport.H2C);
        assert.strictEqual(resolveEffectiveTransport({ hasTls: true, allowHTTP1: true }), EffectiveTransport.TLS_H1_NEGOTIABLE);
        assert.strictEqual(resolveEffectiveTransport({ hasTls: true, allowHTTP1: false }), EffectiveTransport.TLS_H2_ONLY);
    });
});

describe("validateTransport", () => {
    it("mode error + plaintext-h1 + bidi → returns TransportValidationError", () => {
        const err = validateTransport({ registry: [WITH_BIDI], transport: EffectiveTransport.PLAINTEXT_H1, mode: "error" });

        assert.ok(err instanceof TransportValidationError);
        assert.strictEqual(err.code, TRANSPORT_VALIDATION_ERROR_CODE);
        assert.strictEqual(err.methods.length, 1);
    });

    it("never fires on HTTP/2-only transports (h2c, TLS without HTTP/1.1)", () => {
        assert.strictEqual(validateTransport({ registry: [WITH_BIDI], transport: EffectiveTransport.H2C, mode: "error" }), null);
        assert.strictEqual(validateTransport({ registry: [WITH_BIDI], transport: EffectiveTransport.TLS_H2_ONLY, mode: "error" }), null);
    });

    it("TLS with HTTP/1.1 + bidi → one-time warn, never an error", () => {
        const warn = mock.method(console, "warn", () => {});
        try {
            // Even with mode "error" the TLS-h1 case is only a warning
            const result = validateTransport({ registry: [WITH_BIDI], transport: EffectiveTransport.TLS_H1_NEGOTIABLE, mode: "error" });

            assert.strictEqual(result, null);
            assert.strictEqual(warn.mock.calls.length, 1);
            assert.ok(warn.mock.calls[0]?.arguments[0].includes("allowHTTP1: false"));
            assert.ok(warn.mock.calls[0]?.arguments[0].includes("negotiate HTTP/1.1"));
        } finally {
            warn.mock.restore();
        }
    });

    it("TLS with HTTP/1.1 + mode off → no warning", () => {
        const warn = mock.method(console, "warn", () => {});
        try {
            assert.strictEqual(validateTransport({ registry: [WITH_BIDI], transport: EffectiveTransport.TLS_H1_NEGOTIABLE, mode: "off" }), null);
            assert.strictEqual(warn.mock.calls.length, 0);
        } finally {
            warn.mock.restore();
        }
    });

    it("never fires for unary/server-streaming-only services on any transport", () => {
        assert.strictEqual(validateTransport({ registry: [UNARY_ONLY], transport: EffectiveTransport.PLAINTEXT_H1, mode: "error" }), null);
    });

    it("mode off skips the check entirely", () => {
        assert.strictEqual(validateTransport({ registry: [WITH_BIDI], transport: EffectiveTransport.PLAINTEXT_H1, mode: "off" }), null);
    });

    it("mode warn logs exactly once and returns null", () => {
        const warn = mock.method(console, "warn", () => {});
        try {
            const result = validateTransport({ registry: [WITH_BIDI], transport: EffectiveTransport.PLAINTEXT_H1, mode: "warn" });

            assert.strictEqual(result, null);
            assert.strictEqual(warn.mock.calls.length, 1);
        } finally {
            warn.mock.restore();
        }
    });

    it("client-streaming alone does NOT trigger validation (works over HTTP/1.1)", () => {
        assert.strictEqual(validateTransport({ registry: [WITH_CLIENT_STREAM], transport: EffectiveTransport.PLAINTEXT_H1, mode: "error" }), null);
    });
});

describe("formatTransportValidationMessage", () => {
    it("contains methods with kinds, transport mode, remediations, and symptoms", () => {
        const message = formatTransportValidationMessage([{ service: "acme.v1.ScannerService", method: "StreamCodes", kind: "bidi_streaming" }]);

        // Stable code for log searchability
        assert.ok(message.includes(TRANSPORT_VALIDATION_ERROR_CODE));
        // Offending method with kind
        assert.ok(message.includes("acme.v1.ScannerService.StreamCodes"));
        assert.ok(message.includes("bidi_streaming"));
        // Effective transport mode
        assert.ok(message.includes("plaintext HTTP/1.1"));
        // Both remediations
        assert.ok(message.includes("allowHTTP1: false"));
        assert.ok(message.includes("TLS"));
        // Runtime symptoms (searchable)
        assert.ok(message.includes("hangs"));
        assert.ok(message.includes("505"));
        // Escape hatch
        assert.ok(message.includes('transportValidation: "warn" | "off"'));
    });
});
