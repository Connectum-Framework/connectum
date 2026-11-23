/**
 * Validation and compilation of the per-object (`resources`) rules of a method.
 *
 * A rule names an action and the request fields that hold the resource id and type. The field
 * paths are checked against the request message descriptor once, when the method's auth is
 * resolved, and the walk over the descriptor is kept next to the rule so that a call only follows
 * ready-made accessors.
 *
 * @module proto/resource-rules
 */

import type { DescField, DescMessage, DescMethod } from "@bufbuild/protobuf";
import { ScalarType } from "@bufbuild/protobuf";
import type { ResourceRequirement } from "#gen/connectum/auth/v1/options_pb.js";

/**
 * One validated per-object requirement of a method.
 *
 * Exactly one of `type` and `typeField` is set. `types` is the allow-list for `typeField` and is
 * empty for a fixed `type`.
 */
export interface ResolvedResourceRule {
    /** The action (verb or relation) in the vocabulary of the authorization engine. */
    readonly action: string;
    /** Dot path, in proto field names, to the string field that holds the resource id. */
    readonly idField: string;
    /** Fixed resource type, or undefined when the type is read from the request. */
    readonly type: string | undefined;
    /** Dot path to the string field that holds the resource type, or undefined for a fixed type. */
    readonly typeField: string | undefined;
    /** Values `typeField` may hold. */
    readonly types: readonly string[];
}

/** The walk over the request message descriptor that reaches one string field. */
export type FieldPath = readonly PathStep[];

/** One step of a {@link FieldPath}: a field and the message type it belongs to. */
export interface PathStep {
    readonly message: DescMessage;
    readonly field: DescField;
}

/** A rule together with the compiled walks to its id and type fields. */
export interface CompiledResourceRule {
    readonly rule: ResolvedResourceRule;
    readonly idPath: FieldPath;
    readonly typePath: FieldPath | undefined;
}

/**
 * A resource rule that cannot be used: the contract is wrong, not the caller's request.
 *
 * The interceptor answers a call that hits it with `Internal` and keeps the reason in the server
 * log, because the reason names fields of the contract.
 */
export class ResourceRuleError extends Error {
    override readonly name = "ResourceRuleError";
}

const compiledRules = new WeakMap<ResolvedResourceRule, CompiledResourceRule>();

/**
 * The compiled walks of a rule returned by `resolveMethodAuth`.
 *
 * @throws {ResourceRuleError} When the rule was not produced by the reader
 */
export function getCompiledResourceRule(rule: ResolvedResourceRule): CompiledResourceRule {
    const compiled = compiledRules.get(rule);
    if (compiled === undefined) {
        throw new ResourceRuleError("@connectum/auth: a resource rule that did not come from resolveMethodAuth cannot be enforced");
    }
    return compiled;
}

/**
 * Check the `resources` of a method and compile their field paths.
 *
 * @param method - The method the rules belong to; its `input` is the message the paths walk
 * @param rules - The `resources` of the method's `method_auth`
 * @param isPublic - Whether the method is effectively public (declared or inherited)
 * @returns The rules, or undefined when the method declares none
 * @throws {ResourceRuleError} Naming the method, the rule index and the problem
 */
export function resolveResourceRules(method: DescMethod, rules: readonly ResourceRequirement[], isPublic: boolean): readonly ResolvedResourceRule[] | undefined {
    if (rules.length === 0) {
        return undefined;
    }
    const where = `${method.parent.typeName}/${method.name}`;
    if (isPublic) {
        throw new ResourceRuleError(
            `@connectum/auth: ${where} declares resource rules and is public (declared on the method or inherited from the service). ` +
                `A public method skips authorization, so the rules could never run; remove "public" or the rules.`,
        );
    }
    if (method.methodKind === "client_streaming" || method.methodKind === "bidi_streaming") {
        throw new ResourceRuleError(
            `@connectum/auth: ${where} declares resource rules on a ${method.methodKind === "client_streaming" ? "client-streaming" : "bidirectional-streaming"} method. ` +
                `A resource is named by a single request message; only unary and server-streaming methods can carry resource rules.`,
        );
    }

    return rules.map((raw, index) => {
        const at = `${where} resources[${index}]`;
        if (raw.action === "") {
            throw new ResourceRuleError(`@connectum/auth: ${at} has an empty "action".`);
        }
        const hasType = raw.type !== "";
        const hasTypeField = raw.typeField !== "";
        if (hasType === hasTypeField) {
            throw new ResourceRuleError(`@connectum/auth: ${at} must set exactly one of "type" and "type_field"; ${hasType ? "both are set" : "neither is set"}.`);
        }
        if (hasTypeField && raw.types.length === 0) {
            throw new ResourceRuleError(`@connectum/auth: ${at} reads the type from "${raw.typeField}" but lists no allowed "types".`);
        }
        if (hasType && raw.types.length > 0) {
            throw new ResourceRuleError(`@connectum/auth: ${at} sets a fixed "type" and also "types"; "types" only applies together with "type_field".`);
        }
        if (raw.types.includes("")) {
            throw new ResourceRuleError(`@connectum/auth: ${at} lists an empty string in "types".`);
        }
        const idPath = compilePath(method.input, raw.idField, `${at} id_field`);
        const typePath = hasTypeField ? compilePath(method.input, raw.typeField, `${at} type_field`) : undefined;
        const rule: ResolvedResourceRule = {
            action: raw.action,
            idField: raw.idField,
            type: hasType ? raw.type : undefined,
            typeField: hasTypeField ? raw.typeField : undefined,
            types: [...raw.types],
        };
        compiledRules.set(rule, { rule, idPath, typePath });
        return rule;
    });
}

/**
 * Compile a dot path over proto field names into the fields it walks.
 *
 * Every step but the last must be a singular message field (a oneof member is fine); the last must
 * be a singular `string` field.
 */
function compilePath(root: DescMessage, path: string, label: string): FieldPath {
    if (path === "") {
        throw new ResourceRuleError(`@connectum/auth: ${label} is empty.`);
    }
    const names = path.split(".");
    const walk: PathStep[] = [];
    let message = root;
    for (const [position, name] of names.entries()) {
        const field = message.fields.find((candidate) => candidate.name === name);
        if (field === undefined) {
            throw new ResourceRuleError(`@connectum/auth: ${label} "${path}": message ${message.typeName} has no field "${name}" (paths use proto field names).`);
        }
        if (field.fieldKind === "list" || field.fieldKind === "map") {
            throw new ResourceRuleError(
                `@connectum/auth: ${label} "${path}": field "${name}" is ${field.fieldKind === "list" ? "repeated" : "a map"}; a path may not cross a repeated or map field.`,
            );
        }
        walk.push({ message, field });
        if (position === names.length - 1) {
            if (field.fieldKind !== "scalar" || field.scalar !== ScalarType.STRING) {
                throw new ResourceRuleError(`@connectum/auth: ${label} "${path}": field "${name}" must be a singular string field.`);
            }
        } else {
            if (field.fieldKind !== "message") {
                throw new ResourceRuleError(`@connectum/auth: ${label} "${path}": field "${name}" is not a message, so the path cannot continue past it.`);
            }
            message = field.message;
        }
    }
    return walk;
}
