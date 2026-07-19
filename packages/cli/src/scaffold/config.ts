/**
 * Resolve raw CLI input (flags / prompt answers) into a validated {@link ScaffoldConfig}.
 *
 * Pure and testable: both the non-interactive flag path and the interactive TUI
 * collapse to the same `RawInput`, so validation and defaulting live in one place.
 *
 * @module scaffold/config
 */

import type { EventAdapter, NodeExec, PackageManager, ResilienceInterceptor, Runtime, ScaffoldConfig } from "./types.ts";

const RUNTIMES: readonly Runtime[] = ["node", "bun"];
const PACKAGE_MANAGERS: readonly PackageManager[] = ["pnpm", "npm"];
const NODE_EXECS: readonly NodeExec[] = ["raw", "tsx"];
const EVENT_ADAPTERS: readonly EventAdapter[] = ["nats", "kafka", "redpanda", "redis", "amqp"];
const RESILIENCE: readonly ResilienceInterceptor[] = ["timeout", "bulkhead", "circuitBreaker", "retry", "fallback"];

/** Raw, unvalidated input from flags or prompts (all optional except that name is required at resolve time). */
export interface RawInput {
    name?: string | undefined;
    runtime?: string | undefined;
    packageManager?: string | undefined;
    nodeExec?: string | undefined;
    sample?: boolean | undefined;
    otel?: boolean | undefined;
    /** Event adapter name, or undefined/empty to disable the events module. */
    events?: string | undefined;
    auth?: boolean | undefined;
    /** Comma-separated resilience interceptors (e.g. "retry,timeout"). */
    resilience?: string | undefined;
    healthcheck?: boolean | undefined;
    reflection?: boolean | undefined;
    catalog?: boolean | undefined;
}

function oneOf<T extends string>(value: string | undefined, allowed: readonly T[], field: string, fallback: T): T {
    if (value === undefined) {
        return fallback;
    }
    if (!(allowed as readonly string[]).includes(value)) {
        throw new Error(`connectum init: invalid --${field} "${value}" (expected one of: ${allowed.join(", ")})`);
    }
    return value as T;
}

/**
 * Validate + default raw input into a resolved config.
 *
 * @throws Error if `name` is missing or any enum value is invalid.
 */
export function resolveConfig(input: RawInput): ScaffoldConfig {
    const name = (input.name ?? "").trim();
    if (name === "") {
        throw new Error("connectum init: a project name is required (e.g. `connectum init my-service`)");
    }

    const runtime = oneOf(input.runtime, RUNTIMES, "runtime", "node");
    const packageManager = oneOf(input.packageManager, PACKAGE_MANAGERS, "package-manager", "pnpm");
    const nodeExec = oneOf(input.nodeExec, NODE_EXECS, "node-exec", "raw");

    const eventsRaw = (input.events ?? "").trim();
    const events = eventsRaw === "" ? undefined : { adapter: oneOf(eventsRaw, EVENT_ADAPTERS, "events", "nats") };

    const resilience = (input.resilience ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .map((s) => oneOf(s, RESILIENCE, "resilience", "retry"));

    return {
        name,
        runtime,
        packageManager,
        nodeExec,
        sample: input.sample ?? true,
        modules: {
            otel: input.otel ?? false,
            events,
            auth: input.auth ?? false,
            resilience,
            healthcheck: input.healthcheck ?? true,
            reflection: input.reflection ?? true,
            catalog: input.catalog ?? false,
        },
    };
}
