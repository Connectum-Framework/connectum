/**
 * Lazy access to the global OpenTelemetry Tracer
 *
 * @module tracer
 */

import type { Tracer } from "@opentelemetry/api";
import { getProvider } from "./provider.ts";

/**
 * Returns the global Tracer instance.
 * Lazily initializes the OTel provider on first call.
 */
export function getTracer(): Tracer {
    return getProvider().tracer;
}
