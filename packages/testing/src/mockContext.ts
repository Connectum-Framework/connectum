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
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
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

/**
 * Create a {@link Context} whose `ctx.call` / `ctx.stream` resolve against the
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
    const { service, method } = firstServiceAndMethod(options.catalog);

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
    });

    return (server as unknown as ServerInternals)._makeCatalogContext(hctx);
}
