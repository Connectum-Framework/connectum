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
import { safeObjectProperty } from "@bufbuild/protobuf/reflect";
import type { FakeMethodOptions, FakeServiceOptions } from "./types.ts";
import { assertMethodKind } from "./validate.ts";

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
 * @throws TypeError when `options.methodKind` is not `unary`, `server_streaming`,
 *   `client_streaming` or `bidi_streaming`.
 * @throws Error when `options.register` is `true` and the service already has a method
 *   with this name (or the same `localName`); the service is left unchanged.
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
    const methodKind = options?.methodKind === undefined ? "unary" : options.methodKind;
    assertMethodKind(methodKind, `createFakeMethod: method "${name}"`);
    const localName = safeObjectProperty(name.charAt(0).toLowerCase() + name.slice(1));

    // The second registration would add a second entry to `methods` while the lookup keeps
    // only the later one, so the service would disagree with itself. Checked before anything is built.
    if (options?.register && (Object.hasOwn(service.method, localName) || service.methods.some((registered) => registered.name === name))) {
        throw new Error(
            `createFakeMethod: cannot register method "${name}": service "${service.typeName}" already has a method with localName "${localName}"; a method name can be registered once`,
        );
    }

    const method = {
        kind: "rpc",
        name,
        localName,
        parent: service,
        methodKind,
        deprecated: false,
        proto: { options: undefined },
    } as unknown as DescMethod;

    if (options?.register) {
        (service.methods as DescMethod[]).push(method);
        (service.method as Record<string, DescMethod>)[method.localName] = method;
    }

    return method;
}
