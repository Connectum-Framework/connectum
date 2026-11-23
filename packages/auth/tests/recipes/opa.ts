/**
 * Recipe: Open Policy Agent behind a `ResourceAuthorizer`.
 *
 * Maps `check()` to the Data API: `POST /v1/data/{policy path}` with the policy input wrapped in
 * `{ "input": ... }`, answered with `{ "result": <value> }`. The policy decides the shape of
 * `input`; this recipe sends `{ subject, action, resource, context }`. A reply without `result`
 * (the document is undefined) and any result other than `true` deny.
 * https://www.openpolicyagent.org/docs/rest-api#get-a-document-with-input
 */

import type { ResourceAuthorizer } from "../../src/types.ts";
import { type FetchLike, postJson } from "./http.ts";

export interface OpaRecipeOptions {
    /** Base URL of the OPA server, without a trailing slash. */
    readonly baseUrl: string;
    /** Path of the boolean rule, slash separated, for example `connectum/authz/allow`. */
    readonly policyPath: string;
    readonly fetch: FetchLike;
}

export function createOpaAuthorizer(options: OpaRecipeOptions): ResourceAuthorizer {
    const { baseUrl, policyPath } = options;
    return {
        check: async ({ subject, action, resource, context }) => {
            const reply = (await postJson(options.fetch, `${baseUrl}/v1/data/${policyPath}`, {
                input: {
                    subject: { id: subject.subject, roles: subject.roles, scopes: subject.scopes },
                    action,
                    resource: { type: resource.type, id: resource.id },
                    context: { service: context.service, method: context.method },
                },
            })) as { result?: unknown };
            return reply.result === true ? "allow" : "deny";
        },
    };
}
