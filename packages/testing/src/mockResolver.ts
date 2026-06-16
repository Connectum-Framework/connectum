/**
 * `mockResolver` — a {@link RemoteResolver} backed by in-memory mock services.
 *
 * Use it to exercise catalog `ctx.call` / `ctx.stream` (or `server.client`)
 * against canned implementations without a network hop. Every mock response is
 * tagged with the {@link MOCK_RESPONSE_HEADER} so tests can assert the call was
 * served by a mock rather than a real transport.
 *
 * @module mockResolver
 */

import type { DescService } from "@bufbuild/protobuf";
import type { Interceptor, ServiceImpl, Transport } from "@connectrpc/connect";
import { createRouterTransport } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import type { RemoteResolver } from "@connectum/core";

/** Response header set on every mock-served response. */
export const MOCK_RESPONSE_HEADER = "x-connectum-mock";

/** A mocked service: its proto descriptor paired with a (partial) implementation. */
export interface MockService {
    readonly service: DescService;
    readonly impl: Partial<ServiceImpl<DescService>>;
}

/**
 * Type-safe constructor for a {@link MockService}. Pairs a service descriptor
 * with handlers typed against it.
 *
 * @example
 * ```ts
 * mockService(InventoryService, {
 *   getStock: () => create(StockSchema, { units: 7 }),
 * });
 * ```
 */
export function mockService<S extends DescService>(service: S, impl: Partial<ServiceImpl<S>>): MockService {
    return { service, impl: impl as Partial<ServiceImpl<DescService>> };
}

/** Client-side interceptor that tags every mock response with {@link MOCK_RESPONSE_HEADER}. */
const tagMockResponse: Interceptor = (next) => async (req) => {
    const response = await next(req);
    response.header.set(MOCK_RESPONSE_HEADER, "true");
    return response;
};

/**
 * Build a {@link RemoteResolver} that serves the given mocks in-process. Returns
 * `null` for any service not in the mock set (so it composes with real
 * resolvers via `mapResolver`-style fallbacks).
 */
export function mockResolver(mocks: readonly MockService[]): RemoteResolver {
    const transports = new Map<string, Transport>();
    for (const mock of mocks) {
        if (transports.has(mock.service.typeName)) {
            throw new Error(`mockResolver: duplicate mock service "${mock.service.typeName}"`);
        }
        const transport = createRouterTransport(
            (router) => {
                router.service(mock.service, mock.impl);
            },
            { transport: { interceptors: [tagMockResponse] } },
        );
        transports.set(mock.service.typeName, transport);
    }
    return ({ typeName }) => transports.get(typeName) ?? null;
}
