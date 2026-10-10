/**
 * Early ends of streaming calls (client abort, deadline, stalled consumer)
 * behind the generic, cached generic, JWT-secret and session authentication
 * factories, plus the checks that early ends leave nothing behind. The
 * scenarios themselves live in the shared helper so the two halves of the
 * factory list run as separate files.
 */

import { registerEndMatrix, registerLeftoverChecks } from "../helpers/cancel-scenarios.ts";

registerEndMatrix(["generic", "generic-cache", "jwt-secret", "session"]);
registerLeftoverChecks();
