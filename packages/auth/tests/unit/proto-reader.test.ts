/**
 * Unit tests for proto option reader utilities.
 *
 * Tests resolveMethodAuth() and getPublicMethods() for reading
 * authorization configuration from protobuf custom options.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { getPublicMethods, resolveMethodAuth } from "../../src/proto/reader.ts";
import { createFakeMethod, createFakeService, createMethodOptions, createServiceOptions } from "../helpers/proto-test-helpers.ts";

describe("proto-reader", () => {
    describe("resolveMethodAuth()", () => {
        it("should return defaults when no proto options are set", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "PlainMethod", undefined, { register: true });

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.public, false);
            assert.strictEqual(resolved.policy, undefined);
            assert.strictEqual(resolved.requires, undefined);
        });

        it("should resolve method with public: true", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "PublicMethod", createMethodOptions({ public: true }), { register: true });

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.public, true);
        });

        it("should inherit service-level public: true", () => {
            const svcOpts = createServiceOptions({ public: true });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "AnyMethod", undefined, { register: true });

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.public, true);
        });

        it("should resolve method with required roles", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "AdminOnly", createMethodOptions({ requires: { roles: ["admin"] } }), { register: true });

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.public, false);
            assert.ok(resolved.requires);
            assert.deepStrictEqual([...resolved.requires.roles], ["admin"]);
            assert.deepStrictEqual([...resolved.requires.scopes], []);
        });

        it("should resolve method with required scopes", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "ScopedMethod", createMethodOptions({ requires: { scopes: ["read", "write"] } }), { register: true });

            const resolved = resolveMethodAuth(method);

            assert.ok(resolved.requires);
            assert.deepStrictEqual([...resolved.requires.roles], []);
            assert.deepStrictEqual([...resolved.requires.scopes], ["read", "write"]);
        });

        it("should resolve method with roles and scopes combined", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "RolesAndScopes", createMethodOptions({ requires: { roles: ["user"], scopes: ["read"] } }), { register: true });

            const resolved = resolveMethodAuth(method);

            assert.ok(resolved.requires);
            assert.deepStrictEqual([...resolved.requires.roles], ["user"]);
            assert.deepStrictEqual([...resolved.requires.scopes], ["read"]);
        });

        it("should resolve method with policy: allow", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "AllowMethod", createMethodOptions({ policy: "allow" }), { register: true });

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.policy, "allow");
        });

        it("should resolve method with policy: deny", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "DenyMethod", createMethodOptions({ policy: "deny" }), { register: true });

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.policy, "deny");
        });

        it("should inherit service default_policy when method has no policy", () => {
            const svcOpts = createServiceOptions({ defaultPolicy: "deny" });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "InheritsPolicy", undefined, { register: true });

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.policy, "deny");
        });

        it("should override service default_policy with method policy", () => {
            const svcOpts = createServiceOptions({ defaultPolicy: "deny" });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "OverridesPolicy", createMethodOptions({ policy: "allow" }), { register: true });

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.policy, "allow");
        });

        it("should inherit service default_requires when method has no requires", () => {
            const svcOpts = createServiceOptions({ defaultRequires: { roles: ["user"] } });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "InheritsRequires", undefined, { register: true });

            const resolved = resolveMethodAuth(method);

            assert.ok(resolved.requires);
            assert.deepStrictEqual([...resolved.requires.roles], ["user"]);
        });

        it("should override service default_requires with method requires", () => {
            const svcOpts = createServiceOptions({ defaultRequires: { roles: ["user"] } });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "OverridesRequires", createMethodOptions({ requires: { roles: ["admin"] } }), { register: true });

            const resolved = resolveMethodAuth(method);

            assert.ok(resolved.requires);
            assert.deepStrictEqual([...resolved.requires.roles], ["admin"]);
        });

        it("should respect method public: false override on service public: true", () => {
            const svcOpts = createServiceOptions({ public: true });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "SecureMethod", createMethodOptions({ public: false }), { register: true });

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.public, false, "method-level public=false should override service-level public=true");
        });

        it("should cache resolved auth (same reference on second call)", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "CachedMethod", createMethodOptions({ public: true }), { register: true });

            const first = resolveMethodAuth(method);
            const second = resolveMethodAuth(method);

            assert.strictEqual(first, second);
        });

        it("should ignore invalid policy strings", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "InvalidPolicy", createMethodOptions({ policy: "invalid" }), { register: true });

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.policy, undefined);
        });
    });

    describe("getPublicMethods()", () => {
        it("should return patterns for public methods", () => {
            const service = createFakeService({ typeName: "app.v1.AppService" });
            createFakeMethod(service, "PublicMethod", createMethodOptions({ public: true }), { register: true });
            createFakeMethod(service, "PrivateMethod", createMethodOptions({ requires: { roles: ["admin"] } }), { register: true });
            createFakeMethod(service, "AnotherPublic", createMethodOptions({ public: true }), { register: true });

            const result = getPublicMethods([service]);

            assert.deepStrictEqual(result, ["app.v1.AppService/PublicMethod", "app.v1.AppService/AnotherPublic"]);
        });

        it("should return empty array for empty services", () => {
            const result = getPublicMethods([]);

            assert.deepStrictEqual(result, []);
        });

        it("should return empty array when no public methods exist", () => {
            const service = createFakeService();
            createFakeMethod(service, "PrivateMethod", createMethodOptions({ requires: { roles: ["admin"] } }), { register: true });

            const result = getPublicMethods([service]);

            assert.deepStrictEqual(result, []);
        });

        it("should handle service-level public flag", () => {
            const svcOpts = createServiceOptions({ public: true });
            const service = createFakeService({ typeName: "pub.v1.PubService", serviceOptions: svcOpts });
            createFakeMethod(service, "MethodA", undefined, { register: true });
            createFakeMethod(service, "MethodB", undefined, { register: true });

            const result = getPublicMethods([service]);

            assert.deepStrictEqual(result, ["pub.v1.PubService/MethodA", "pub.v1.PubService/MethodB"]);
        });

        it("should combine methods from multiple services", () => {
            const svc1 = createFakeService({ typeName: "svc1.v1.Svc1" });
            createFakeMethod(svc1, "Public1", createMethodOptions({ public: true }), { register: true });
            createFakeMethod(svc1, "Private1", undefined, { register: true });

            const svc2Opts = createServiceOptions({ public: true });
            const svc2 = createFakeService({ typeName: "svc2.v1.Svc2", serviceOptions: svc2Opts });
            createFakeMethod(svc2, "AllPublic", undefined, { register: true });

            const result = getPublicMethods([svc1, svc2]);

            assert.deepStrictEqual(result, ["svc1.v1.Svc1/Public1", "svc2.v1.Svc2/AllPublic"]);
        });
    });
});
