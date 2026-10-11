/**
 * Early ends of streaming calls (client abort, deadline, stalled consumer)
 * behind the cached session, gateway, internal and remote-JWKS authentication
 * factories. The scenarios live in the shared helper so the two halves of the
 * factory list run as separate files.
 */

import { registerEndMatrix } from "../helpers/cancel-scenarios.ts";

registerEndMatrix(["session-cache", "gateway", "internal", "jwt-jwks"]);
