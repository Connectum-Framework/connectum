/**
 * Recipe: OpenFGA behind a `ResourceAuthorizer`.
 *
 * Maps `check()` to the Check endpoint of the OpenFGA HTTP API:
 * `POST /stores/{store_id}/check` with `{ tuple_key: { user, relation, object }, authorization_model_id? }`,
 * answered with `{ allowed: boolean }`.
 * https://openfga.dev/api/service#/Relationship%20Queries/Check
 * (field names: the `CheckBody`, `CheckRequestTupleKey` and `CheckResponse` definitions of the
 * published OpenAPI document, https://github.com/openfga/api/blob/main/docs/openapiv2/apidocs.swagger.json)
 */

import type { ResourceAuthorizer } from "../../src/types.ts";
import { type FetchLike, postJson } from "./http.ts";

export interface OpenFgaRecipeOptions {
    /** Base URL of the OpenFGA server, without a trailing slash. */
    readonly apiUrl: string;
    readonly storeId: string;
    /** Pin the authorization model; the server uses the latest model when omitted. */
    readonly authorizationModelId?: string;
    /** Object type that identifies a caller in the model. @default "user" */
    readonly userType?: string;
    readonly fetch: FetchLike;
    /** Value of the `Authorization` header, for example `Bearer <token>`. */
    readonly authorization?: string;
}

export function createOpenFgaAuthorizer(options: OpenFgaRecipeOptions): ResourceAuthorizer {
    const { apiUrl, storeId, authorizationModelId, userType = "user", authorization } = options;
    return {
        check: async ({ subject, action, resource }) => {
            const reply = (await postJson(
                options.fetch,
                `${apiUrl}/stores/${encodeURIComponent(storeId)}/check`,
                {
                    tuple_key: { user: `${userType}:${subject.subject}`, relation: action, object: `${resource.type}:${resource.id}` },
                    ...(authorizationModelId !== undefined && { authorization_model_id: authorizationModelId }),
                },
                authorization === undefined ? {} : { authorization },
            )) as { allowed?: unknown };
            return reply.allowed === true ? "allow" : "deny";
        },
    };
}
