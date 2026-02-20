/**
 * Unit tests for proto option reader utilities.
 *
 * Tests resolveMethodAuth() and getPublicMethods() for reading
 * authorization configuration from protobuf custom options.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import type { DescMethod, DescService } from "@bufbuild/protobuf";
import { create, setExtension } from "@bufbuild/protobuf";
import { MethodOptionsSchema, ServiceOptionsSchema } from "@bufbuild/protobuf/wkt";
import { AuthRequirementsSchema, MethodAuthSchema, method_auth, ServiceAuthSchema, service_auth } from "#gen/connectum/auth/v1/options_pb.js";
import { getPublicMethods, resolveMethodAuth } from "../../src/proto/reader.ts";

/**
 * Create a fake DescService with optional proto service options.
 */
function createFakeService(options?: { typeName?: string; serviceOptions?: unknown }): DescService {
    return {
        kind: "service",
        typeName: options?.typeName ?? "test.v1.TestService",
        name: "TestService",
        methods: [],
        method: {},
        deprecated: false,
        proto: { options: options?.serviceOptions },
    } as unknown as DescService;
}

/**
 * Create a fake DescMethod attached to a service, with optional proto method options.
 */
function createFakeMethod(service: DescService, name: string, methodOptions?: unknown): DescMethod {
    const method = {
        kind: "rpc",
        name,
        localName: name.charAt(0).toLowerCase() + name.slice(1),
        parent: service,
        methodKind: "unary",
        deprecated: false,
        proto: { options: methodOptions },
    } as unknown as DescMethod;
    (service.methods as DescMethod[]).push(method);
    return method;
}

/**
 * Create MethodOptions with method_auth extension set.
 */
function createMethodOptions(authConfig: { public?: boolean; policy?: string; requires?: { roles?: string[]; scopes?: string[] } }) {
    const opts = create(MethodOptionsSchema);
    const init: Record<string, unknown> = {
        policy: authConfig.policy ?? "",
    };
    // Only set public when explicitly provided to preserve proto2 field presence semantics
    if (authConfig.public !== undefined) {
        init.public = authConfig.public;
    }
    if (authConfig.requires) {
        init.requires = create(AuthRequirementsSchema, {
            roles: authConfig.requires.roles ?? [],
            scopes: authConfig.requires.scopes ?? [],
        });
    }
    const authMsg = create(MethodAuthSchema, init as any);
    setExtension(opts, method_auth, authMsg);
    return opts;
}

/**
 * Create ServiceOptions with service_auth extension set.
 */
function createServiceOptions(authConfig: { defaultPolicy?: string; public?: boolean; defaultRequires?: { roles?: string[]; scopes?: string[] } }) {
    const opts = create(ServiceOptionsSchema);
    const init: Record<string, unknown> = {
        defaultPolicy: authConfig.defaultPolicy ?? "",
    };
    // Only set public when explicitly provided to preserve proto2 field presence semantics
    if (authConfig.public !== undefined) {
        init.public = authConfig.public;
    }
    if (authConfig.defaultRequires) {
        init.defaultRequires = create(AuthRequirementsSchema, {
            roles: authConfig.defaultRequires.roles ?? [],
            scopes: authConfig.defaultRequires.scopes ?? [],
        });
    }
    const authMsg = create(ServiceAuthSchema, init as any);
    setExtension(opts, service_auth, authMsg);
    return opts;
}

describe("proto-reader", () => {
    describe("resolveMethodAuth()", () => {
        it("should return defaults when no proto options are set", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "PlainMethod");

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.public, false);
            assert.strictEqual(resolved.policy, undefined);
            assert.strictEqual(resolved.requires, undefined);
        });

        it("should resolve method with public: true", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "PublicMethod", createMethodOptions({ public: true }));

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.public, true);
        });

        it("should inherit service-level public: true", () => {
            const svcOpts = createServiceOptions({ public: true });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "AnyMethod");

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.public, true);
        });

        it("should resolve method with required roles", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "AdminOnly", createMethodOptions({ requires: { roles: ["admin"] } }));

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.public, false);
            assert.ok(resolved.requires);
            assert.deepStrictEqual([...resolved.requires.roles], ["admin"]);
            assert.deepStrictEqual([...resolved.requires.scopes], []);
        });

        it("should resolve method with required scopes", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "ScopedMethod", createMethodOptions({ requires: { scopes: ["read", "write"] } }));

            const resolved = resolveMethodAuth(method);

            assert.ok(resolved.requires);
            assert.deepStrictEqual([...resolved.requires.roles], []);
            assert.deepStrictEqual([...resolved.requires.scopes], ["read", "write"]);
        });

        it("should resolve method with roles and scopes combined", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "RolesAndScopes", createMethodOptions({ requires: { roles: ["user"], scopes: ["read"] } }));

            const resolved = resolveMethodAuth(method);

            assert.ok(resolved.requires);
            assert.deepStrictEqual([...resolved.requires.roles], ["user"]);
            assert.deepStrictEqual([...resolved.requires.scopes], ["read"]);
        });

        it("should resolve method with policy: allow", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "AllowMethod", createMethodOptions({ policy: "allow" }));

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.policy, "allow");
        });

        it("should resolve method with policy: deny", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "DenyMethod", createMethodOptions({ policy: "deny" }));

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.policy, "deny");
        });

        it("should inherit service default_policy when method has no policy", () => {
            const svcOpts = createServiceOptions({ defaultPolicy: "deny" });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "InheritsPolicy");

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.policy, "deny");
        });

        it("should override service default_policy with method policy", () => {
            const svcOpts = createServiceOptions({ defaultPolicy: "deny" });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "OverridesPolicy", createMethodOptions({ policy: "allow" }));

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.policy, "allow");
        });

        it("should inherit service default_requires when method has no requires", () => {
            const svcOpts = createServiceOptions({ defaultRequires: { roles: ["user"] } });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "InheritsRequires");

            const resolved = resolveMethodAuth(method);

            assert.ok(resolved.requires);
            assert.deepStrictEqual([...resolved.requires.roles], ["user"]);
        });

        it("should override service default_requires with method requires", () => {
            const svcOpts = createServiceOptions({ defaultRequires: { roles: ["user"] } });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "OverridesRequires", createMethodOptions({ requires: { roles: ["admin"] } }));

            const resolved = resolveMethodAuth(method);

            assert.ok(resolved.requires);
            assert.deepStrictEqual([...resolved.requires.roles], ["admin"]);
        });

        it("should respect method public: false override on service public: true", () => {
            const svcOpts = createServiceOptions({ public: true });
            const service = createFakeService({ serviceOptions: svcOpts });
            const method = createFakeMethod(service, "SecureMethod", createMethodOptions({ public: false }));

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.public, false, "method-level public=false should override service-level public=true");
        });

        it("should cache resolved auth (same reference on second call)", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "CachedMethod", createMethodOptions({ public: true }));

            const first = resolveMethodAuth(method);
            const second = resolveMethodAuth(method);

            assert.strictEqual(first, second);
        });

        it("should ignore invalid policy strings", () => {
            const service = createFakeService();
            const method = createFakeMethod(service, "InvalidPolicy", createMethodOptions({ policy: "invalid" }));

            const resolved = resolveMethodAuth(method);

            assert.strictEqual(resolved.policy, undefined);
        });
    });

    describe("getPublicMethods()", () => {
        it("should return patterns for public methods", () => {
            const service = createFakeService({ typeName: "app.v1.AppService" });
            createFakeMethod(service, "PublicMethod", createMethodOptions({ public: true }));
            createFakeMethod(service, "PrivateMethod", createMethodOptions({ requires: { roles: ["admin"] } }));
            createFakeMethod(service, "AnotherPublic", createMethodOptions({ public: true }));

            const result = getPublicMethods([service]);

            assert.deepStrictEqual(result, ["app.v1.AppService/PublicMethod", "app.v1.AppService/AnotherPublic"]);
        });

        it("should return empty array for empty services", () => {
            const result = getPublicMethods([]);

            assert.deepStrictEqual(result, []);
        });

        it("should return empty array when no public methods exist", () => {
            const service = createFakeService();
            createFakeMethod(service, "PrivateMethod", createMethodOptions({ requires: { roles: ["admin"] } }));

            const result = getPublicMethods([service]);

            assert.deepStrictEqual(result, []);
        });

        it("should handle service-level public flag", () => {
            const svcOpts = createServiceOptions({ public: true });
            const service = createFakeService({ typeName: "pub.v1.PubService", serviceOptions: svcOpts });
            createFakeMethod(service, "MethodA");
            createFakeMethod(service, "MethodB");

            const result = getPublicMethods([service]);

            assert.deepStrictEqual(result, ["pub.v1.PubService/MethodA", "pub.v1.PubService/MethodB"]);
        });

        it("should combine methods from multiple services", () => {
            const svc1 = createFakeService({ typeName: "svc1.v1.Svc1" });
            createFakeMethod(svc1, "Public1", createMethodOptions({ public: true }));
            createFakeMethod(svc1, "Private1");

            const svc2Opts = createServiceOptions({ public: true });
            const svc2 = createFakeService({ typeName: "svc2.v1.Svc2", serviceOptions: svc2Opts });
            createFakeMethod(svc2, "AllPublic");

            const result = getPublicMethods([svc1, svc2]);

            assert.deepStrictEqual(result, ["svc1.v1.Svc1/Public1", "svc2.v1.Svc2/AllPublic"]);
        });
    });
});
