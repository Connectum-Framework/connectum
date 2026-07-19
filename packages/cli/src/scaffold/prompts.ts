/**
 * Interactive wizard for `connectum init` (task 2.1). Collects any answers not
 * supplied as flags via `@clack/prompts`, and collapses to the same `RawInput` the
 * non-interactive flag path produces (D-5).
 *
 * The prompt calls go through a small {@link Prompter} seam so the wizard logic can
 * be unit-tested with a stub — `@clack/prompts` is loaded lazily and never imported
 * in tests (which also sidesteps clack's `bun:test` module-mock limitation, D-5).
 *
 * @module scaffold/prompts
 */

import type { RawInput } from "./config.ts";

/** Minimal prompt surface; the clack implementation handles cancellation (exit). */
export interface Prompter {
    text(opts: { message: string; placeholder?: string; validate?: (v: string | undefined) => string | undefined }): Promise<string>;
    select<T extends string>(opts: { message: string; options: { value: T; label?: string }[]; initialValue?: T }): Promise<T>;
    confirm(opts: { message: string; initialValue?: boolean }): Promise<boolean>;
}

/** True when the wizard must be skipped (explicit `--yes`, CI, or a non-TTY stdout). */
export function isNonInteractive(flags: { yes?: boolean | undefined }): boolean {
    return flags.yes === true || process.env.CI === "true" || !process.stdout.isTTY;
}

/** Default {@link Prompter} backed by `@clack/prompts` (loaded lazily). */
export const clackPrompter: Prompter = {
    async text(opts) {
        const p = await import("@clack/prompts");
        const v = await p.text(opts);
        if (p.isCancel(v)) {
            p.cancel("Aborted.");
            process.exit(1);
        }
        return v;
    },
    async select(opts) {
        const p = await import("@clack/prompts");
        const v = await p.select(opts as never);
        if (p.isCancel(v)) {
            p.cancel("Aborted.");
            process.exit(1);
        }
        return v as never;
    },
    async confirm(opts) {
        const p = await import("@clack/prompts");
        const v = await p.confirm(opts);
        if (p.isCancel(v)) {
            p.cancel("Aborted.");
            process.exit(1);
        }
        return v;
    },
};

const RUNTIME_OPTIONS = [
    { value: "node" as const, label: "Node.js" },
    { value: "bun" as const, label: "Bun" },
];
const NODE_EXEC_OPTIONS = [
    { value: "raw" as const, label: "raw .ts (Node >=25.2)" },
    { value: "tsx" as const, label: "tsx (Node >=22.13)" },
];
const PM_OPTIONS = [
    { value: "pnpm" as const, label: "pnpm" },
    { value: "npm" as const, label: "npm" },
];
const ADAPTER_OPTIONS = [{ value: "nats" as const }, { value: "kafka" as const }, { value: "redpanda" as const }, { value: "redis" as const }, { value: "amqp" as const }];

/**
 * Collect a full {@link RawInput}: in non-interactive mode return the flags as-is
 * (validation/defaults happen in `resolveConfig`); otherwise prompt for anything the
 * flags did not already provide.
 */
export async function collectConfig(flags: RawInput & { yes?: boolean | undefined }, prompter: Prompter = clackPrompter): Promise<RawInput> {
    if (isNonInteractive(flags)) {
        return flags;
    }
    return promptForMissing(flags, prompter);
}

/**
 * Prompt (via `prompter`) for every field the flags did not already provide. Always
 * interactive — {@link collectConfig} owns the non-interactive short-circuit.
 */
export async function promptForMissing(flags: RawInput, prompter: Prompter): Promise<RawInput> {
    const name =
        flags.name ??
        (await prompter.text({
            message: "Project name",
            placeholder: "my-service",
            validate: (v) => ((v ?? "").trim() === "" ? "A project name is required" : undefined),
        }));
    const runtime = flags.runtime ?? (await prompter.select({ message: "Runtime", options: RUNTIME_OPTIONS, initialValue: "node" }));
    const nodeExec =
        runtime === "node" ? (flags.nodeExec ?? (await prompter.select({ message: "Node execution model", options: NODE_EXEC_OPTIONS, initialValue: "raw" }))) : flags.nodeExec;
    const packageManager = flags.packageManager ?? (await prompter.select({ message: "Package manager", options: PM_OPTIONS, initialValue: "pnpm" }));
    const otel = flags.otel ?? (await prompter.confirm({ message: "Add OpenTelemetry?", initialValue: false }));
    const auth = flags.auth ?? (await prompter.confirm({ message: "Add auth (JWT + proto authorization)?", initialValue: false }));

    let events = flags.events;
    if (events === undefined) {
        const wantEvents = await prompter.confirm({ message: "Add an EventBus?", initialValue: false });
        events = wantEvents ? await prompter.select({ message: "Event adapter", options: ADAPTER_OPTIONS, initialValue: "nats" }) : undefined;
    }

    const sample = flags.sample ?? (await prompter.confirm({ message: "Include the sample Greeter service?", initialValue: true }));

    return { name, runtime, packageManager, nodeExec, sample, otel, auth, events };
}
