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

import { randomUUID } from "node:crypto";
import type { DescService } from "@bufbuild/protobuf";
import type { Interceptor, ServiceImpl, Transport } from "@connectrpc/connect";
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect";
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
 * A handler that throws a `ConnectError` answers with exactly that error. Any
 * other exception (a typo in the mock, a rejected promise, a thrown string)
 * reaches the caller as a `ConnectError` with code `Internal`, the exception's
 * own message and the exception itself as `cause`, so a broken mock shows up
 * in the test output instead of as an anonymous "internal error".
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

/**
 * Internal error-metadata key that carries the identity of a failure of a mock
 * implementation from the handler side of the in-memory transport to its client
 * side, where it is removed again. The transport serializes errors, so the
 * original error object cannot travel with the `ConnectError`; this key lets the
 * client side look it up and set it as `cause`.
 */
const MOCK_ERROR_ID_HEADER = "x-connectum-mock-error-id";

/** Original errors of mock implementations, by the id carried in {@link MOCK_ERROR_ID_HEADER}. */
type MockErrors = Map<string, unknown>;

/**
 * What a client sees when a mock implementation throws something that is not a
 * `ConnectError`. Connect's default handler mapping turns it into `Internal`
 * with the fixed text "internal error", which hides a typo in the mock. The
 * mock runs in the test process, so nothing is hidden from a client by keeping
 * the author's message and error: the failure becomes `Internal` with the
 * original message, and the original error is restored as `cause` on the
 * client side. A `ConnectError` and an `AbortError`/`TimeoutError` (what an
 * aborted signal produces) are the mock's deliberate answer and pass through.
 */
function toMockFailure(thrown: unknown, errors: MockErrors): unknown {
    if (thrown instanceof ConnectError) {
        return thrown;
    }
    if (thrown instanceof Error && (thrown.name === "AbortError" || thrown.name === "TimeoutError")) {
        return thrown;
    }
    const id = randomUUID();
    errors.set(id, thrown);
    return new ConnectError(thrown instanceof Error ? thrown.message : String(thrown), Code.Internal, { [MOCK_ERROR_ID_HEADER]: id }, undefined, thrown);
}

/** Wrap the functions of a mock implementation so that their failures go through {@link toMockFailure}. */
function withReportedFailures(service: DescService, impl: Partial<ServiceImpl<DescService>>, errors: MockErrors): Partial<ServiceImpl<DescService>> {
    const source = impl as Record<string, unknown>;
    const wrapped: Record<string, unknown> = {};
    for (const method of service.methods) {
        const handler = source[method.localName];
        if (typeof handler !== "function") {
            continue;
        }
        if (method.methodKind === "server_streaming" || method.methodKind === "bidi_streaming") {
            wrapped[method.localName] = async function* (...args: unknown[]) {
                try {
                    yield* handler.apply(impl, args);
                } catch (thrown) {
                    throw toMockFailure(thrown, errors);
                }
            };
        } else {
            wrapped[method.localName] = async (...args: unknown[]) => {
                try {
                    return await handler.apply(impl, args);
                } catch (thrown) {
                    throw toMockFailure(thrown, errors);
                }
            };
        }
    }
    return wrapped as Partial<ServiceImpl<DescService>>;
}

/** Restore the original error as `cause` of a failure marked by {@link toMockFailure}, and drop the marker. */
function restoreMockFailure(thrown: unknown, errors: MockErrors): unknown {
    if (!(thrown instanceof ConnectError)) {
        return thrown;
    }
    const id = thrown.metadata.get(MOCK_ERROR_ID_HEADER);
    if (id === null) {
        return thrown;
    }
    thrown.metadata.delete(MOCK_ERROR_ID_HEADER);
    if (errors.has(id)) {
        thrown.cause = errors.get(id);
        errors.delete(id);
    }
    return thrown;
}

async function* restoreMockFailures<T>(messages: AsyncIterable<T>, errors: MockErrors): AsyncGenerator<T> {
    try {
        yield* messages;
    } catch (thrown) {
        throw restoreMockFailure(thrown, errors);
    }
}

/**
 * Client-side interceptor that tags every mock response with
 * {@link MOCK_RESPONSE_HEADER} and gives a failure of the mock back its
 * original error as `cause`.
 */
function tagMockResponse(errors: MockErrors): Interceptor {
    return (next) => async (req) => {
        let response: Awaited<ReturnType<typeof next>>;
        try {
            response = await next(req);
        } catch (thrown) {
            throw restoreMockFailure(thrown, errors);
        }
        response.header.set(MOCK_RESPONSE_HEADER, "true");
        if (response.stream) {
            return { ...response, message: restoreMockFailures(response.message, errors) };
        }
        return response;
    };
}

/**
 * Build a {@link @connectum/core!RemoteResolver | RemoteResolver} that serves the given mocks in-process. Returns
 * `null` for services outside the mock set. To fall back to another resolver,
 * wrap both resolvers in a caller-provided function; the server accepts one
 * resolver and does not compose them automatically.
 */
export function mockResolver(mocks: readonly MockService[]): RemoteResolver {
    const transports = new Map<string, Transport>();
    for (const mock of mocks) {
        if (transports.has(mock.service.typeName)) {
            throw new Error(`mockResolver: duplicate mock service "${mock.service.typeName}"`);
        }
        const errors: MockErrors = new Map();
        const transport = createRouterTransport(
            (router) => {
                router.service(mock.service, withReportedFailures(mock.service, mock.impl, errors));
            },
            { transport: { interceptors: [tagMockResponse(errors)] } },
        );
        transports.set(mock.service.typeName, transport);
    }
    return ({ typeName }) => transports.get(typeName) ?? null;
}
