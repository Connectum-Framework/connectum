/**
 * `createMockContext` — a Connectum {@link Context} for unit-testing handler
 * `ctx.call` / `ctx.stream` logic in isolation.
 *
 * It drives the SAME dispatch path as a live request: a real `Server` is built
 * with the given catalog and a {@link mockResolver}, and a synthetic
 * `HandlerContext` is wrapped through the server's catalog dispatcher. So
 * resolver lookup, cascade injection, interceptor composition and error
 * semantics all match production — there is no parallel mock dispatch path to
 * drift from.
 *
 * @module mockContext
 */

import type { DescMethod, DescService } from "@bufbuild/protobuf";
import { createHandlerContext, type HandlerContext, type Interceptor } from "@connectrpc/connect";
import { type Context, createServer, type ServiceCatalog } from "@connectum/core";
import { type MockService, mockResolver } from "./mockResolver.ts";

/** Options for {@link createMockContext}. */
export interface CreateMockContextOptions {
    /** The catalog the handler-under-test calls into. */
    readonly catalog: ServiceCatalog;
    /** Mock implementations served via the catalog's resolver path. */
    readonly mocks: readonly MockService[];
    /** Optional outgoing interceptors (applied exactly as in production). */
    readonly outgoingInterceptors?: readonly Interceptor[];
    /** Optional inbound headers (seen by `ctx.requestHeader` + header propagation). */
    readonly requestHeader?: HeadersInit;
    /** Optional inbound deadline in ms (drives the `ctx.timeoutMs()` cascade). */
    readonly timeoutMs?: number;
    /** Optional header names propagated onto outgoing calls (default none). */
    readonly propagateHeaders?: readonly string[];
    /**
     * The method of the handler under test, as `"<service typeName>/<method name>"`
     * (for example `"t.v1.Hello/Say"`, the key format of `ctx.call`). It is what the
     * handler reads as `ctx.service`, `ctx.method` and `ctx.url`. Without it the
     * context describes the first method of the first service of the catalog, which
     * is the right answer only for a catalog of one method.
     */
    readonly method?: string;
    /**
     * Abort signal of the inbound request: `ctx.signal` aborts when it does, and
     * the abort cascades into the outgoing calls the handler makes. Without it
     * `ctx.signal` never aborts.
     */
    readonly signal?: AbortSignal;
}

interface ServerInternals {
    _makeCatalogContext(hctx: HandlerContext): Context;
}

function firstServiceAndMethod(catalog: ServiceCatalog): { service: DescService; method: DescMethod } {
    const entries = Object.entries(catalog);
    const first = entries[0];
    if (first === undefined) {
        throw new Error("createMockContext: catalog must contain at least one service.");
    }
    const [typeName, service] = first;
    const method = service.methods[0];
    if (method === undefined) {
        throw new Error(`createMockContext: service "${typeName}" has no methods.`);
    }
    return { service, method };
}

/** Resolve `"<service typeName>/<method name>"` against the catalog. */
function namedServiceAndMethod(catalog: ServiceCatalog, name: unknown): { service: DescService; method: DescMethod } {
    if (typeof name !== "string") {
        throw new TypeError(`createMockContext: options.method must be a string like "pkg.v1.Service/Method", got ${typeof name}.`);
    }
    const separator = name.lastIndexOf("/");
    const typeName = name.slice(0, separator);
    const methodName = name.slice(separator + 1);
    if (separator <= 0 || methodName === "") {
        throw new TypeError(`createMockContext: options.method must have the form "pkg.v1.Service/Method", got "${name}".`);
    }
    const service = Object.values(catalog).find((candidate) => candidate.typeName === typeName);
    if (service === undefined) {
        throw new TypeError(`createMockContext: options.method "${name}": service "${typeName}" is not in the catalog.`);
    }
    const method = service.methods.find((candidate) => candidate.name === methodName);
    if (method === undefined) {
        throw new TypeError(`createMockContext: options.method "${name}": method "${methodName}" is not a method of "${typeName}".`);
    }
    return { service, method };
}

/**
 * Create a {@link @connectum/core!Context | Context} whose `ctx.call` / `ctx.stream` resolve against the
 * given mocks. Pass it as the second argument to a handler under test.
 *
 * @example
 * ```ts
 * const ctx = createMockContext({
 *   catalog: defineCatalog({ [InventoryService.typeName]: InventoryService }),
 *   mocks: [mockService(InventoryService, { getStock: () => create(StockSchema, { units: 7 }) })],
 * });
 * const res = await orderHandler(create(CreateOrderSchema, { sku: "x" }), ctx);
 * ```
 */
export function createMockContext(options: CreateMockContextOptions): Context {
    if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
        throw new TypeError("createMockContext: options.signal must be an AbortSignal.");
    }
    const { service, method } = options.method === undefined ? firstServiceAndMethod(options.catalog) : namedServiceAndMethod(options.catalog, options.method);

    const server = createServer({
        services: [],
        catalog: options.catalog,
        remoteResolver: mockResolver(options.mocks),
        ...(options.outgoingInterceptors ? { outgoingInterceptors: options.outgoingInterceptors } : {}),
        ...(options.propagateHeaders ? { propagateHeaders: options.propagateHeaders } : {}),
    });

    const hctx = createHandlerContext({
        service,
        method,
        protocolName: "connect",
        requestMethod: "POST",
        url: `https://mock/${service.typeName}/${method.name}`,
        ...(options.requestHeader ? { requestHeader: options.requestHeader } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.signal !== undefined ? { requestSignal: options.signal } : {}),
    });

    return (server as unknown as ServerInternals)._makeCatalogContext(hctx);
}
