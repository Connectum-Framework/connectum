/**
 * Unit tests for trusted headers reader
 *
 * Tests createTrustedHeadersReader() for fail-closed behavior,
 * IP/CIDR matching, and auth header parsing from trusted peers.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { createTrustedHeadersReader } from "../../src/trusted-headers.ts";
import { AUTH_HEADERS } from "../../src/types.ts";

function createMockReq(peerAddress: string | undefined, headers?: Record<string, string>) {
    const h = new Headers();
    if (headers) {
        for (const [key, value] of Object.entries(headers)) {
            h.set(key, value);
        }
    }
    if (peerAddress !== undefined) {
        return { header: h, peerAddress };
    }
    return { header: h };
}

describe("trusted-headers", () => {
    describe("createTrustedHeadersReader()", () => {
        it("should return null when trustedProxies is empty (fail-closed)", () => {
            const reader = createTrustedHeadersReader({ trustedProxies: [] });

            const req = createMockReq("10.0.0.1", {
                [AUTH_HEADERS.SUBJECT]: "user-1",
                [AUTH_HEADERS.TYPE]: "jwt",
            });

            const result = reader(req);
            assert.strictEqual(result, null);
        });

        it("should return null when peerAddress is missing", () => {
            const reader = createTrustedHeadersReader({ trustedProxies: ["10.0.0.1"] });

            const req = createMockReq(undefined, {
                [AUTH_HEADERS.SUBJECT]: "user-1",
                [AUTH_HEADERS.TYPE]: "jwt",
            });

            const result = reader(req);
            assert.strictEqual(result, null);
        });

        it("should return null when peerAddress doesn't match", () => {
            const reader = createTrustedHeadersReader({ trustedProxies: ["10.0.0.1"] });

            const req = createMockReq("192.168.1.1", {
                [AUTH_HEADERS.SUBJECT]: "user-1",
                [AUTH_HEADERS.TYPE]: "jwt",
            });

            const result = reader(req);
            assert.strictEqual(result, null);
        });

        it("should return AuthContext when peer matches exact IP", () => {
            const reader = createTrustedHeadersReader({ trustedProxies: ["10.0.0.1"] });

            const req = createMockReq("10.0.0.1", {
                [AUTH_HEADERS.SUBJECT]: "trusted-user",
                [AUTH_HEADERS.TYPE]: "jwt",
                [AUTH_HEADERS.ROLES]: '["admin"]',
                [AUTH_HEADERS.SCOPES]: "read write",
            });

            const result = reader(req);
            assert.ok(result);
            assert.strictEqual(result.subject, "trusted-user");
            assert.strictEqual(result.type, "jwt");
            assert.deepStrictEqual(result.roles, ["admin"]);
            assert.deepStrictEqual(result.scopes, ["read", "write"]);
        });

        it("should return AuthContext when peer matches CIDR range", () => {
            const reader = createTrustedHeadersReader({ trustedProxies: ["10.0.0.0/8"] });

            const req = createMockReq("10.255.128.42", {
                [AUTH_HEADERS.SUBJECT]: "cidr-user",
                [AUTH_HEADERS.TYPE]: "mtls",
            });

            const result = reader(req);
            assert.ok(result);
            assert.strictEqual(result.subject, "cidr-user");
            assert.strictEqual(result.type, "mtls");
        });

        it("should return null when auth headers missing even for trusted peer", () => {
            const reader = createTrustedHeadersReader({ trustedProxies: ["10.0.0.1"] });

            // No auth headers set — parseAuthHeaders returns undefined
            const req = createMockReq("10.0.0.1");

            const result = reader(req);
            assert.strictEqual(result, null);
        });
    });
});
