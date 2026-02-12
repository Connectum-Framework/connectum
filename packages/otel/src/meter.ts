/**
 * Lazy access to the global OpenTelemetry Meter
 *
 * @module meter
 */

import type { Meter } from "@opentelemetry/api";
import { getProvider } from "./provider.ts";

/**
 * Returns the global Meter instance.
 * Lazily initializes the OTel provider on first call.
 */
export function getMeter(): Meter {
    return getProvider().meter;
}
