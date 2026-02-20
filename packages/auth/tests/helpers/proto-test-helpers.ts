/**
 * Shared test helpers for proto-based authorization tests.
 *
 * Provides factory functions for creating fake protobuf descriptors
 * (DescService, DescMethod) and proto options (MethodOptions, ServiceOptions)
 * with auth extensions set.
 */

import { mock } from "node:test";
import type { DescMethod, DescService } from "@bufbuild/protobuf";
import { create, setExtension } from "@bufbuild/protobuf";
import { MethodOptionsSchema, ServiceOptionsSchema } from "@bufbuild/protobuf/wkt";
import { AuthRequirementsSchema, MethodAuthSchema, method_auth, ServiceAuthSchema, service_auth } from "#gen/connectum/auth/v1/options_pb.js";

/**
 * Create a fake DescService with optional proto service options.
 *
 * @param options - Optional overrides for typeName and serviceOptions.
 * @returns A fake DescService suitable for unit/integration tests.
 */
export function createFakeService(options?: { typeName?: string; serviceOptions?: unknown }): DescService {
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
 *
 * When `options.register` is `true`, the method is pushed into `service.methods`,
 * which is required for tests that call `getPublicMethods()` (iterates service.methods).
 *
 * @param service - The parent DescService.
 * @param name - The RPC method name.
 * @param methodOptions - Proto method options (e.g., from `createMethodOptions()`).
 * @param options - Additional options. Set `register: true` to push into service.methods.
 * @returns A fake DescMethod suitable for unit/integration tests.
 */
export function createFakeMethod(service: DescService, name: string, methodOptions?: unknown, options?: { register?: boolean }): DescMethod {
    const method = {
        kind: "rpc",
        name,
        localName: name.charAt(0).toLowerCase() + name.slice(1),
        parent: service,
        methodKind: "unary",
        deprecated: false,
        proto: { options: methodOptions },
    } as unknown as DescMethod;

    if (options?.register) {
        (service.methods as DescMethod[]).push(method);
    }

    return method;
}

/**
 * Create MethodOptions with method_auth extension set.
 *
 * Uses presence-aware semantics for the `public` field: only sets it
 * when explicitly provided, preserving proto2 field presence behavior.
 *
 * @param authConfig - Auth configuration for the method.
 * @returns Protobuf MethodOptions with the method_auth extension.
 */
export function createMethodOptions(authConfig: { public?: boolean; policy?: string; requires?: { roles?: string[]; scopes?: string[] } }) {
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
 *
 * Uses presence-aware semantics for the `public` field: only sets it
 * when explicitly provided, preserving proto2 field presence behavior.
 *
 * @param authConfig - Auth configuration for the service.
 * @returns Protobuf ServiceOptions with the service_auth extension.
 */
export function createServiceOptions(authConfig: { defaultPolicy?: string; public?: boolean; defaultRequires?: { roles?: string[]; scopes?: string[] } }) {
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

/**
 * Create a mock ConnectRPC request with proto service/method descriptors.
 *
 * @param service - The DescService for the request.
 * @param method - The DescMethod for the request.
 * @param headers - Optional HTTP headers for the request.
 * @returns A mock request object compatible with ConnectRPC interceptors.
 */
export function createProtoMockRequest(service: DescService, method: DescMethod, headers?: Headers) {
    return {
        service,
        method,
        header: headers ?? new Headers(),
        url: `http://localhost/${service.typeName}/${method.name}`,
        stream: false,
        message: {},
    } as any;
}

/**
 * Create a mock next handler that returns an empty response.
 *
 * @returns A mock function usable as a ConnectRPC next handler.
 */
export function createMockNext() {
    return mock.fn(async (_req: any) => ({ message: {} })) as any;
}
