/**
 * Factory functions for fake protobuf service and method descriptors.
 *
 * These generic helpers create minimal {@link DescService} and {@link DescMethod}
 * objects suitable for unit-testing ConnectRPC interceptors and utilities
 * without depending on real proto definitions.
 *
 * @module
 */

import type { DescMethod, DescService } from "@bufbuild/protobuf";
import type { FakeMethodOptions, FakeServiceOptions } from "./types.ts";

/**
 * Create a fake {@link DescService} descriptor for testing.
 *
 * The returned object has the same shape as a real `DescService` produced by
 * the protobuf compiler, but contains only the fields commonly accessed in
 * interceptor and utility code. The `methods` array and `method` lookup map
 * start empty; use {@link createFakeMethod} with `register: true` to populate them.
 *
 * @param options - Optional overrides for service name and typeName.
 * @returns A fake `DescService` suitable for unit/integration tests.
 *
 * @example
 * ```ts
 * import { createFakeService } from "@connectum/testing";
 *
 * const svc = createFakeService({ typeName: "acme.v1.UserService" });
 * // svc.typeName === "acme.v1.UserService"
 * // svc.name     === "UserService"
 * ```
 */
export function createFakeService(options?: FakeServiceOptions): DescService {
    const typeName = options?.typeName ?? "test.v1.TestService";
    const name = options?.name ?? typeName.split(".").pop() ?? "TestService";

    return {
        kind: "service",
        typeName,
        name,
        methods: [],
        method: {},
        deprecated: false,
        proto: { options: undefined },
    } as unknown as DescService;
}

/**
 * Create a fake {@link DescMethod} descriptor attached to a service.
 *
 * When `options.register` is `true`, the method is pushed into
 * `service.methods` and added to `service.method` (keyed by `localName`).
 * This is required for tests that iterate over service methods
 * (e.g., `getPublicMethods()`).
 *
 * @param service - The parent `DescService` (typically from {@link createFakeService}).
 * @param name - The RPC method name (PascalCase, e.g. `"GetUser"`).
 * @param options - Optional configuration for method kind and registration.
 * @returns A fake `DescMethod` suitable for unit/integration tests.
 *
 * @example
 * ```ts
 * import { createFakeService, createFakeMethod } from "@connectum/testing";
 *
 * const svc = createFakeService();
 * const method = createFakeMethod(svc, "GetUser", { register: true });
 * // method.localName === "getUser"
 * // svc.methods.length === 1
 * ```
 */
export function createFakeMethod(service: DescService, name: string, options?: FakeMethodOptions): DescMethod {
    const method = {
        kind: "rpc",
        name,
        localName: name.charAt(0).toLowerCase() + name.slice(1),
        parent: service,
        methodKind: options?.methodKind ?? "unary",
        deprecated: false,
        proto: { options: undefined },
    } as unknown as DescMethod;

    if (options?.register) {
        (service.methods as DescMethod[]).push(method);
        (service.method as Record<string, DescMethod>)[method.localName] = method;
    }

    return method;
}
