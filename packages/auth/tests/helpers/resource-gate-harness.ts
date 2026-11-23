/**
 * Harness that runs one call through `createProtoAuthzInterceptor` with a recording authorizer.
 *
 * It reports what the tests need to tell apart: whether the handler ran, which questions the
 * authorizer was asked, and the error code the caller saw.
 */

import { Code, ConnectError } from "@connectrpc/connect";
import { authContextStorage } from "../../src/context.ts";
import { markInternalContext } from "../../src/internal-context.ts";
import { createProtoAuthzInterceptor } from "../../src/proto/proto-authz-interceptor.ts";
import type { AuthContext, ProtoAuthzInterceptorOptions, ResourceCheck, ResourceDecision } from "../../src/types.ts";
import { createProtoMockRequest } from "./proto-test-helpers.ts";
import { buildResourceService, messageOf, type ResourceMethodSpec } from "./resource-test-helpers.ts";

export const caller: AuthContext = { subject: "user-1", roles: [], scopes: [], claims: {}, type: "test" };

/** An identity the internal interceptor would have established. */
export function trustedInternalCaller(): AuthContext {
    const context: AuthContext = { ...caller, subject: "peer-service" };
    markInternalContext(context);
    return context;
}

export type Answer = ResourceDecision | ((input: ResourceCheck) => unknown);

export interface Outcome {
    readonly handled: number;
    /** The message the handler received, if it ran. */
    readonly handledMessage: unknown;
    readonly asked: ResourceCheck[];
    /** Code of the error the caller saw, or undefined when the call succeeded. */
    readonly code: Code | undefined;
    readonly error: unknown;
    /** What the interceptor logged. */
    readonly logged: { readonly warn: string[]; readonly error: string[] };
}

export interface RunOptions {
    readonly method: ResourceMethodSpec;
    readonly serviceAuth?: { public?: boolean; internal?: boolean; defaultPolicy?: string };
    readonly interceptor?: ProtoAuthzInterceptorOptions;
    /** Without an authorizer at all, use `authorizer: null`. */
    readonly authorizer?: Answer | null;
    readonly subject?: AuthContext | null;
    readonly request?: Record<string, unknown>;
}

/** Run one unary call to a method built from `options.method`. */
export async function run(options: RunOptions): Promise<Outcome> {
    const { service, methods } = buildResourceService({ Call: options.method }, options.serviceAuth);
    const method = methods.Call as NonNullable<typeof methods.Call>;
    const message = messageOf(method, options.request ?? { id: "d1" });
    const asked: ResourceCheck[] = [];
    const logged = { warn: [] as string[], error: [] as string[] };
    const answer = options.authorizer === undefined ? "allow" : options.authorizer;

    const interceptor = createProtoAuthzInterceptor({
        logger: { warn: (text) => logged.warn.push(text), error: (text) => logged.error.push(text) },
        ...options.interceptor,
        ...(answer !== null && {
            resourceAuthorizer: {
                check: (input) => {
                    asked.push(input);
                    return (typeof answer === "function" ? answer(input) : answer) as ResourceDecision;
                },
            },
        }),
    });

    let handled = 0;
    let handledMessage: unknown;
    const handler = interceptor((async (req: { message: unknown }) => {
        handled += 1;
        handledMessage = req.message;
        return { message: {} };
    }) as never);

    const subject = options.subject === undefined ? caller : options.subject;
    const call = () => handler({ ...createProtoMockRequest(service, method), message } as never);
    let code: Code | undefined;
    let error: unknown;
    try {
        await (subject === null ? call() : authContextStorage.run(subject, call));
    } catch (thrown) {
        error = thrown;
        code = thrown instanceof ConnectError ? thrown.code : undefined;
        if (!(thrown instanceof ConnectError)) {
            code = Code.Unknown;
        }
    }
    return { handled, handledMessage, asked, code, error, logged };
}

/** The usual single rule: `read` on `doc:<id>`. */
export const READ_DOC = [{ action: "read", idField: "id", type: "doc" }] as const;
