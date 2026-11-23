/**
 * The resource gate of the proto authorization interceptor.
 *
 * Runs after the method-level decision allowed a call to a method that declares `resources`
 * rules: it reads each referenced object from the request message once, asks the
 * {@link ResourceAuthorizer} about every one in declaration order, and only then lets the handler
 * run on the very message it read.
 *
 * @module proto/resource-gate
 */

import type { DescMethod, Message } from "@bufbuild/protobuf";
import type { ReflectMessage } from "@bufbuild/protobuf/reflect";
import { reflect } from "@bufbuild/protobuf/reflect";
import type { StreamRequest, StreamResponse, UnaryRequest, UnaryResponse } from "@connectrpc/connect";
import { Code, ConnectError } from "@connectrpc/connect";
import type { AuthContext, HideExistence, ResourceAuthorizer, ResourceAuthzLogger } from "../types.ts";
import type { FieldPath, ResolvedResourceRule } from "./resource-rules.ts";
import { getCompiledResourceRule } from "./resource-rules.ts";

type Next = (req: UnaryRequest | StreamRequest) => Promise<UnaryResponse | StreamResponse>;

/** A reference the request makes to one object, read from the message. */
interface ResourceReference {
    readonly rule: ResolvedResourceRule;
    readonly type: string;
    readonly id: string;
}

export interface ResourceGateOptions {
    readonly resourceAuthorizer: ResourceAuthorizer | undefined;
    readonly hideExistence: HideExistence | undefined;
    readonly logger: ResourceAuthzLogger;
}

/**
 * Create the gate. The returned function either calls `next` with the checked request or throws.
 */
export function createResourceGate(
    options: ResourceGateOptions,
): (next: Next, req: UnaryRequest | StreamRequest, rules: readonly ResolvedResourceRule[], authContext: AuthContext | undefined) => Promise<UnaryResponse | StreamResponse> {
    const { resourceAuthorizer, hideExistence, logger } = options;
    const warned = new WeakSet<DescMethod>();

    /** Ask the authorizer. Only the literal "allow" is a yes; a thrown value that is not a ConnectError is Internal. */
    async function ask(
        authorizer: ResourceAuthorizer,
        req: UnaryRequest | StreamRequest,
        subject: AuthContext,
        action: string,
        reference: ResourceReference,
        message: object,
    ): Promise<boolean> {
        try {
            const decision = await authorizer.check({
                subject,
                action,
                resource: { type: reference.type, id: reference.id },
                context: { service: req.service.typeName, method: req.method.name, message: message as never },
            });
            return decision === "allow";
        } catch (error) {
            if (error instanceof ConnectError) {
                throw error;
            }
            logger.error(`@connectum/auth: resourceAuthorizer.check failed for ${req.service.typeName}/${req.method.name}; the client receives Internal`, error);
            throw new ConnectError("Internal error", Code.Internal, undefined, undefined, error);
        }
    }

    return async (next, req, rules, authContext) => {
        if (authContext === undefined) {
            throw new ConnectError("Authentication required for authorization", Code.Unauthenticated);
        }
        const authorizer = resourceAuthorizer;
        if (authorizer === undefined) {
            if (!warned.has(req.method)) {
                warned.add(req.method);
                logger.warn(
                    `@connectum/auth: ${req.service.typeName}/${req.method.name} declares resource rules but createProtoAuthzInterceptor has no resourceAuthorizer; every call to it is denied`,
                );
            }
            throw new ConnectError("Access denied", Code.PermissionDenied);
        }

        // A server-streaming request is one message delivered as a stream: take the first element and
        // hand the handler a stream that yields it again, so the handler sees the message that was checked.
        let forwarded: UnaryRequest | StreamRequest = req;
        let message: object;
        let iterator: AsyncIterator<unknown> | undefined;
        if (req.stream) {
            iterator = req.message[Symbol.asyncIterator]();
            const first = await iterator.next();
            if (first.done) {
                throw new ConnectError("Invalid request: the request carries no message to read the resource from", Code.InvalidArgument);
            }
            message = first.value as object;
            forwarded = { ...req, message: replay(first.value, iterator) } as StreamRequest;
        } else {
            message = req.message as object;
        }

        // Until the handler gets the replayed stream, nobody else will release the source: on any exit
        // other than the hand-over the stream read ahead is closed here.
        try {
            // Every reference is read before the first check: an unreadable one must not be preceded by an
            // authorizer call about another object, and each field is read exactly once.
            const references = rules.map((rule) => readReference(rule, message));

            for (const reference of references) {
                if (await ask(authorizer, req, authContext, reference.rule.action, reference, message)) {
                    continue;
                }
                if (hideExistence !== undefined) {
                    const byType = hideExistence.byType;
                    const visibilityAction = byType !== undefined && Object.hasOwn(byType, reference.type) ? (byType[reference.type] as string) : hideExistence.action;
                    if (!(await ask(authorizer, req, authContext, visibilityAction, reference, message))) {
                        throw new ConnectError("Not found", Code.NotFound);
                    }
                }
                throw new ConnectError("Access denied", Code.PermissionDenied);
            }
        } catch (error) {
            await release(iterator);
            throw error;
        }

        return await next(forwarded);
    };
}

/** Close the source stream of a refused request. A failure to close must not replace the decision that is being thrown. */
async function release(iterator: AsyncIterator<unknown> | undefined): Promise<void> {
    try {
        await iterator?.return?.();
    } catch {
        // The refusal the caller is about to throw is the answer; the close failure carries nothing the client needs.
    }
}

/** Yield the message that was read ahead, then the rest of the stream, and release the source when done. */
async function* replay<T>(first: T, iterator: AsyncIterator<T>): AsyncGenerator<T> {
    try {
        yield first;
        for (let step = await iterator.next(); !step.done; step = await iterator.next()) {
            yield step.value;
        }
    } finally {
        await iterator.return?.();
    }
}

function readReference(rule: ResolvedResourceRule, message: object): ResourceReference {
    const compiled = getCompiledResourceRule(rule);
    const id = readString(compiled.idPath, rule.idField, message);
    if (rule.type !== undefined) {
        return { rule, type: rule.type, id };
    }
    const type = readString(compiled.typePath as FieldPath, rule.typeField as string, message);
    if (!rule.types.includes(type)) {
        throw new ConnectError(`Invalid request: "${rule.typeField}" must be one of ${rule.types.map((allowed) => `"${allowed}"`).join(", ")}`, Code.InvalidArgument);
    }
    return { rule, type, id };
}

/**
 * Follow a compiled path to its string field. An unset parent message, an unset oneof member and an
 * empty string are all invalid input.
 *
 * Fields are read through protobuf reflection, which knows how the message stores oneof members, so
 * a member of a oneof that is not the one set reads as unset.
 */
function readString(path: FieldPath, label: string, message: object): string {
    let current: unknown = message;
    for (const [position, step] of path.entries()) {
        const view = reflect(step.message, current as Message);
        if (!view.isSet(step.field)) {
            current = undefined;
            break;
        }
        const value = view.get(step.field);
        current = position === path.length - 1 ? value : (value as ReflectMessage).message;
    }
    if (typeof current !== "string" || current === "") {
        throw new ConnectError(`Invalid request: "${label}" must be a non-empty string`, Code.InvalidArgument);
    }
    return current;
}
