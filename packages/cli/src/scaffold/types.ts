/**
 * Shared types for the `connectum init` scaffolding pipeline.
 *
 * @module scaffold/types
 */

/** Target runtime for the scaffolded project. */
export type Runtime = "node" | "bun";

/** Package manager the scaffolded project is configured for. */
export type PackageManager = "pnpm" | "npm";

/**
 * Node execution model (only meaningful when {@link Runtime} is `node`):
 * - `raw`: run `.ts` sources directly via native type-stripping (Node >= 25.2.0);
 * - `tsx`: run via `tsx` (Node >= 22.13.0).
 */
export type NodeExec = "raw" | "tsx";

/** EventBus transport adapter. */
export type EventAdapter = "nats" | "kafka" | "redpanda" | "redis" | "amqp";

/**
 * Optional modules the user can enable. Each maps to an additive {@link ScaffoldConfig}
 * fragment (deps + wiring). Healthcheck and Reflection are part of the base and are
 * not toggled here.
 */
export interface ModuleSelection {
    /** OpenTelemetry: adds `createOtelInterceptor` (outermost) + provider lifecycle. */
    otel?: boolean;
    /** EventBus: adds `@connectum/events` + the chosen adapter, an EventRoute, and proto. */
    events?: { adapter: EventAdapter } | undefined;
    /** Auth: adds `@connectum/auth` (JWT + proto-driven authorization) + a second buf module. */
    auth?: boolean;
}

/**
 * Fully-resolved scaffolding configuration (the flat object both the interactive
 * TUI and the non-interactive flag path collapse to).
 */
export interface ScaffoldConfig {
    /** Project name / target directory. */
    name: string;
    /** Target runtime. */
    runtime: Runtime;
    /** Package manager. */
    packageManager: PackageManager;
    /** Node execution model (ignored when `runtime` is `bun`). */
    nodeExec: NodeExec;
    /** Emit the runnable sample service (`true`) or config-only (`false`). */
    sample: boolean;
    /** Enabled optional modules. */
    modules: ModuleSelection;
}

/**
 * The Node floor implied by a Node execution model:
 * - `raw` → 25.2.0 (native `.ts` execution);
 * - `tsx` → 22.13.0 (compiled-consumer floor).
 */
export function nodeEngineFloor(nodeExec: NodeExec): string {
    return nodeExec === "raw" ? ">=25.2.0" : ">=22.13.0";
}
