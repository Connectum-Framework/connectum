/**
 * Recipe: SpiceDB behind a `ResourceAuthorizer`.
 *
 * Maps `check()` to `authzed.api.v1.PermissionsService.CheckPermission`, called through its HTTP
 * mapping `POST /v1/permissions/check` (body `*`). The request fields are those of
 * `CheckPermissionRequest` in `buf.build/authzed/api` (`resource` as an `ObjectReference`,
 * `permission`, `subject` as a `SubjectReference`, optional `consistency`), written in the
 * protobuf JSON mapping. A caller is allowed only when `permissionship` is
 * `PERMISSIONSHIP_HAS_PERMISSION`; a conditional permission (`PERMISSIONSHIP_CONDITIONAL_PERMISSION`)
 * is not an allow.
 */

import type { ResourceAuthorizer } from "../../src/types.ts";
import { type FetchLike, postJson } from "./http.ts";

export interface SpiceDbRecipeOptions {
    /** Base URL of the SpiceDB HTTP endpoint, without a trailing slash. */
    readonly endpoint: string;
    /** Preshared key, sent as `Authorization: Bearer <key>`. */
    readonly presharedKey: string;
    /** Object type that identifies a caller in the schema. @default "user" */
    readonly subjectType?: string;
    readonly fetch: FetchLike;
}

export function createSpiceDbAuthorizer(options: SpiceDbRecipeOptions): ResourceAuthorizer {
    const { endpoint, presharedKey, subjectType = "user" } = options;
    return {
        check: async ({ subject, action, resource }) => {
            const reply = (await postJson(
                options.fetch,
                `${endpoint}/v1/permissions/check`,
                {
                    consistency: { minimizeLatency: true },
                    resource: { objectType: resource.type, objectId: resource.id },
                    permission: action,
                    subject: { object: { objectType: subjectType, objectId: subject.subject } },
                },
                { authorization: `Bearer ${presharedKey}` },
            )) as { permissionship?: unknown };
            return reply.permissionship === "PERMISSIONSHIP_HAS_PERMISSION" ? "allow" : "deny";
        },
    };
}
