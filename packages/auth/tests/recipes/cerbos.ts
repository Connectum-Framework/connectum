/**
 * Recipe: Cerbos behind a `ResourceAuthorizer`.
 *
 * Maps `check()` to `POST /api/check/resources`:
 * `{ principal: { id, roles, attr }, resources: [{ resource: { kind, id }, actions: [action] }] }`,
 * answered with `results[].actions` mapping each action to `EFFECT_ALLOW` or `EFFECT_DENY`.
 * https://docs.cerbos.dev/cerbos/latest/api/index.html
 */

import type { ResourceAuthorizer } from "../../src/types.ts";
import { type FetchLike, postJson } from "./http.ts";

export interface CerbosRecipeOptions {
    /** Base URL of the Cerbos HTTP endpoint, without a trailing slash. */
    readonly baseUrl: string;
    readonly fetch: FetchLike;
}

export function createCerbosAuthorizer(options: CerbosRecipeOptions): ResourceAuthorizer {
    return {
        check: async ({ subject, action, resource }) => {
            const reply = (await postJson(options.fetch, `${options.baseUrl}/api/check/resources`, {
                principal: { id: subject.subject, roles: [...subject.roles], attr: { scopes: [...subject.scopes] } },
                resources: [{ resource: { kind: resource.type, id: resource.id }, actions: [action] }],
            })) as { results?: Array<{ actions?: Record<string, unknown> }> };
            return reply.results?.[0]?.actions?.[action] === "EFFECT_ALLOW" ? "allow" : "deny";
        },
    };
}
