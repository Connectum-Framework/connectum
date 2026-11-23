/**
 * Recipe: Cedar through Amazon Verified Permissions behind a `ResourceAuthorizer`.
 *
 * Maps `check()` to `IsAuthorized`: `{ policyStoreId, principal: { entityType, entityId },
 * action: { actionType, actionId }, resource: { entityType, entityId } }`, answered with
 * `{ decision: "ALLOW" | "DENY" }`. The call is injected as a function over the request so that the
 * AWS SDK client (`IsAuthorizedCommand`, whose input has exactly these members) or a signed HTTP
 * call can stand behind it.
 * https://docs.aws.amazon.com/verifiedpermissions/latest/apireference/API_IsAuthorized.html
 */

import type { ResourceAuthorizer } from "../../src/types.ts";

export interface IsAuthorizedInput {
    readonly policyStoreId: string;
    readonly principal: { readonly entityType: string; readonly entityId: string };
    readonly action: { readonly actionType: string; readonly actionId: string };
    readonly resource: { readonly entityType: string; readonly entityId: string };
}

export interface CedarRecipeOptions {
    readonly policyStoreId: string;
    /** Entity type of a caller in the schema, for example `PhotoFlash::User`. */
    readonly principalType: string;
    /** Action namespace, for example `PhotoFlash::Action` or just `Action`. @default "Action" */
    readonly actionType?: string;
    /**
     * Maps a contract resource type to a Cedar entity type; an unlisted type is used as is.
     * Cedar entity types are namespaced, for example `doc` to `PhotoFlash::Photo`.
     */
    readonly entityTypes?: Readonly<Record<string, string>>;
    readonly isAuthorized: (input: IsAuthorizedInput) => Promise<{ decision?: unknown }>;
}

export function createCedarAuthorizer(options: CedarRecipeOptions): ResourceAuthorizer {
    const { policyStoreId, principalType, actionType = "Action", entityTypes = {} } = options;
    return {
        check: async ({ subject, action, resource }) => {
            const reply = await options.isAuthorized({
                policyStoreId,
                principal: { entityType: principalType, entityId: subject.subject },
                action: { actionType, actionId: action },
                resource: { entityType: Object.hasOwn(entityTypes, resource.type) ? (entityTypes[resource.type] as string) : resource.type, entityId: resource.id },
            });
            return reply.decision === "ALLOW" ? "allow" : "deny";
        },
    };
}
