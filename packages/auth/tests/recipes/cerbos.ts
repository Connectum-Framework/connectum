/**
 * Recipe: Cerbos behind a `ResourceAuthorizer`.
 *
 * Maps `check()` to `POST /api/check/resources`:
 * `{ principal: { id, roles, attr }, resources: [{ resource: { kind, id }, actions: [action] }] }`,
 * answered with `results[].actions` mapping each action to `EFFECT_ALLOW` or `EFFECT_DENY`.
 * Request fields follow `CheckResourcesRequest` of `buf.build/cerbos/cerbos-api` (exported with `buf export`): `principal.id`
 * and at least one `principal.roles` are required, as are `resources[].resource` and at least one action.
 * https://docs.cerbos.dev/cerbos/latest/api/index.html
 */

import type { ResourceAuthorizer } from "../../src/types.ts";
import { type FetchLike, postJson } from "./http.ts";

export interface CerbosRecipeOptions {
    /** Base URL of the Cerbos HTTP endpoint, without a trailing slash. */
    readonly baseUrl: string;
    /**
     * Role sent for a caller who has none. The Cerbos request schema (`cerbos.engine.v1.Principal`
     * in `buf.build/cerbos/cerbos-api`) requires at least one role, so without this a caller with
     * no roles is denied here instead of being sent as an invalid request.
     */
    readonly roleForCallerWithoutRoles?: string;
    readonly fetch: FetchLike;
}

export function createCerbosAuthorizer(options: CerbosRecipeOptions): ResourceAuthorizer {
    return {
        check: async ({ subject, action, resource }) => {
            const roles = subject.roles.length > 0 ? [...subject.roles] : options.roleForCallerWithoutRoles === undefined ? [] : [options.roleForCallerWithoutRoles];
            if (roles.length === 0) {
                return "deny";
            }
            const reply = (await postJson(options.fetch, `${options.baseUrl}/api/check/resources`, {
                principal: { id: subject.subject, roles, attr: { scopes: [...subject.scopes] } },
                resources: [{ resource: { kind: resource.type, id: resource.id }, actions: [action] }],
            })) as { results?: Array<{ actions?: Record<string, unknown> }> };
            return reply.results?.[0]?.actions?.[action] === "EFFECT_ALLOW" ? "allow" : "deny";
        },
    };
}
