/**
 * Unit tests for the interactive wizard. The prompting logic is tested via a stub
 * Prompter (no @clack/prompts loaded), plus the non-interactive short-circuit.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { RawInput } from "../../src/scaffold/config.ts";
import { resolveConfig } from "../../src/scaffold/config.ts";
import { collectConfig, isNonInteractive, type Prompter, promptForMissing } from "../../src/scaffold/prompts.ts";

function stubPrompter(answers: { text?: string; select?: Record<string, string>; confirm?: Record<string, boolean> } = {}): { prompter: Prompter; calls: string[] } {
    const calls: string[] = [];
    const prompter: Prompter = {
        async text(opts) {
            calls.push(`text:${opts.message}`);
            return answers.text ?? "stubbed";
        },
        async select(opts) {
            calls.push(`select:${opts.message}`);
            return (answers.select?.[opts.message] ?? opts.options[0]?.value) as never;
        },
        async confirm(opts) {
            calls.push(`confirm:${opts.message}`);
            return answers.confirm?.[opts.message] ?? false;
        },
    };
    return { prompter, calls };
}

const originalCi = process.env.CI;
const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

/** Pin the two environment signals the wizard reads, so a test does not depend on where it runs. */
function setEnvironment(env: { ci: string | undefined; isTTY: boolean | undefined }): void {
    if (env.ci === undefined) {
        delete process.env.CI;
    } else {
        process.env.CI = env.ci;
    }
    Object.defineProperty(process.stdout, "isTTY", { value: env.isTTY, configurable: true, writable: true });
}

function restoreEnvironment(): void {
    if (originalCi === undefined) {
        delete process.env.CI;
    } else {
        process.env.CI = originalCi;
    }
    if (originalIsTTY === undefined) {
        delete (process.stdout as { isTTY?: boolean }).isTTY;
    } else {
        Object.defineProperty(process.stdout, "isTTY", originalIsTTY);
    }
}

// The guide documents three independent reasons to run without a wizard: `--yes`, `CI=true`
// and a standard output that is not a terminal. Each case below leaves exactly one of them on,
// so a condition dropped from the check cannot hide behind another.
describe("collectConfig", () => {
    afterEach(restoreEnvironment);

    const flags: RawInput & { yes?: boolean } = { name: "svc", runtime: "bun" };

    for (const scenario of [
        { title: "--yes on a terminal outside CI", yes: true, ci: undefined, isTTY: true },
        { title: "CI=true on a terminal without --yes", yes: undefined, ci: "true", isTTY: true },
        { title: "a piped stdout outside CI without --yes", yes: undefined, ci: undefined, isTTY: false },
    ]) {
        it(`returns the flags untouched and asks nothing with ${scenario.title}`, async () => {
            setEnvironment({ ci: scenario.ci, isTTY: scenario.isTTY });
            const { prompter, calls } = stubPrompter({ text: "from-the-wizard" });
            const out = await collectConfig({ ...flags, yes: scenario.yes }, prompter);
            assert.equal(out.name, "svc");
            assert.equal(out.runtime, "bun");
            assert.equal(out.packageManager, undefined);
            assert.equal(out.otel, undefined);
            assert.deepEqual(calls, []);
        });
    }

    it("asks the wizard on a terminal outside CI without --yes", async () => {
        setEnvironment({ ci: undefined, isTTY: true });
        const { prompter, calls } = stubPrompter({ text: "from-the-wizard" });
        const out = await collectConfig({ runtime: "bun" }, prompter);
        assert.equal(out.name, "from-the-wizard");
        assert.ok(calls.includes("text:Project name"));
    });
});

describe("promptForMissing", () => {
    // Every answer differs from the value the wizard would fall back to for that question, so a
    // question that is skipped (or answered from a default) shows up as a wrong field.
    it("takes each answer from its own question when the flags provide nothing", async () => {
        const { prompter, calls } = stubPrompter({
            text: "billing-svc",
            select: { Runtime: "node", "Node execution model": "tsx", "Package manager": "bun", "Event adapter": "redpanda" },
            confirm: { "Add OpenTelemetry?": true, "Add auth (JWT + proto authorization)?": true, "Add an EventBus?": true },
        });
        const out = await promptForMissing({}, prompter);
        assert.equal(out.name, "billing-svc");
        assert.equal(out.runtime, "node");
        assert.equal(out.nodeExec, "tsx");
        assert.equal(out.packageManager, "bun");
        assert.equal(out.otel, true);
        assert.equal(out.auth, true);
        assert.equal(out.events, "redpanda");
        // Auth is on, so the sample is implied and the wizard must not ask whether to include it.
        assert.equal(out.sample, true);
        assert.deepEqual(calls, [
            "text:Project name",
            "select:Runtime",
            "select:Node execution model",
            "select:Package manager",
            "confirm:Add OpenTelemetry?",
            "confirm:Add auth (JWT + proto authorization)?",
            "confirm:Add an EventBus?",
            "select:Event adapter",
        ]);
    });

    it("asks about the sample service and records a refusal when neither auth nor events is chosen", async () => {
        const { prompter, calls } = stubPrompter({
            text: "plain",
            select: { Runtime: "bun", "Package manager": "npm" },
            confirm: { "Include the sample Greeter service?": false },
        });
        const out = await promptForMissing({}, prompter);
        assert.equal(out.runtime, "bun");
        assert.equal(out.packageManager, "npm");
        assert.equal(out.nodeExec, undefined);
        assert.equal(out.otel, false);
        assert.equal(out.auth, false);
        assert.equal(out.events, undefined);
        assert.equal(out.sample, false);
        assert.ok(calls.includes("confirm:Include the sample Greeter service?"));
    });

    it("does not prompt for fields already provided", async () => {
        const flags: RawInput = { name: "svc", runtime: "bun", packageManager: "npm", otel: true, auth: false, events: "kafka", sample: false };
        const { prompter, calls } = stubPrompter();
        const out = await promptForMissing(flags, prompter);
        assert.deepEqual(calls, []);
        assert.equal(out.events, "kafka");
        assert.equal(out.runtime, "bun");
    });

    it("skips node-exec for the bun runtime", async () => {
        const { prompter, calls } = stubPrompter({ select: { Runtime: "bun" } });
        await promptForMissing({}, prompter);
        assert.ok(!calls.includes("select:Node execution model"));
    });

    it("goes straight to the adapter picker when --events was passed with no value", async () => {
        const { prompter, calls } = stubPrompter({ select: { "Event adapter": "redis" } });
        const out = await promptForMissing({ events: "" }, prompter);
        assert.equal(out.events, "redis");
        assert.ok(!calls.includes("confirm:Add an EventBus?"));
    });

    it("asks for an adapter only when the user opts into events", async () => {
        const { prompter, calls } = stubPrompter({ confirm: { "Add an EventBus?": true }, select: { "Event adapter": "amqp" } });
        const out = await promptForMissing({}, prompter);
        assert.equal(out.events, "amqp");
        assert.ok(calls.includes("select:Event adapter"));
    });
});

describe("promptForMissing: what the wizard asks and accepts", () => {
    /** Records what each question offers and hands the project name check to the test. */
    function recordingPrompter(): { prompter: Prompter; offered: Map<string, string[]>; nameCheck: () => (value: string | undefined) => string | undefined } {
        const offered = new Map<string, string[]>();
        let check: ((value: string | undefined) => string | undefined) | undefined;
        const prompter: Prompter = {
            async text(opts) {
                check = opts.validate;
                return "svc";
            },
            async select(opts) {
                offered.set(
                    opts.message,
                    opts.options.map((option) => option.value),
                );
                return opts.options[0]?.value as never;
            },
            // Events are switched on so that the adapter question is asked as well.
            async confirm(opts) {
                return opts.message === "Add an EventBus?";
            },
        };
        return {
            prompter,
            offered,
            nameCheck: () => {
                assert.ok(check !== undefined, "the project name question has no validation");
                return check;
            },
        };
    }

    // The guide's flag table lists the accepted values of each flag, and every interactive choice
    // has a flag; Deno is out of scope, so it must not be offered.
    it("offers exactly the values the flags of the guide accept", async () => {
        const { prompter, offered } = recordingPrompter();
        await promptForMissing({}, prompter);
        assert.deepEqual(offered.get("Runtime"), ["node", "bun"]);
        assert.deepEqual(offered.get("Node execution model"), ["raw", "tsx"]);
        assert.deepEqual(offered.get("Package manager"), ["pnpm", "npm", "bun"]);
        assert.deepEqual(offered.get("Event adapter"), ["nats", "kafka", "redpanda", "redis", "amqp"]);
    });

    // The wizard applies the rule of the non-interactive path, with its message, instead of
    // accepting a name that would only be refused afterwards.
    it("rejects an invalid project name with the message the non-interactive path gives, and accepts a valid one", async () => {
        const { prompter, nameCheck } = recordingPrompter();
        await promptForMissing({}, prompter);
        const check = nameCheck();
        for (const invalid of ["My-App", "my app", "node_modules", "a${b}c"]) {
            let expected = "";
            try {
                resolveConfig({ name: invalid });
            } catch (err) {
                expected = (err as Error).message;
            }
            assert.notEqual(expected, "", `${invalid} must be refused by the non-interactive path`);
            assert.equal(check(invalid), expected, invalid);
        }
        assert.equal(check("billing"), undefined);
        assert.equal(check("apps/billing"), undefined);
        for (const blank of ["", "   ", undefined]) {
            assert.equal(typeof check(blank), "string", `a blank answer (${JSON.stringify(blank)}) must be refused`);
        }
    });
});

describe("isNonInteractive: environment signals", () => {
    afterEach(restoreEnvironment);

    it("skips the wizard when CI is true, even on a terminal", () => {
        setEnvironment({ ci: "true", isTTY: true });
        assert.equal(isNonInteractive({}), true);
    });

    it("skips the wizard when stdout is not a terminal, with no CI and no --yes", () => {
        setEnvironment({ ci: undefined, isTTY: false });
        assert.equal(isNonInteractive({}), true);
    });

    it("skips the wizard under CI with a piped stdout and no --yes", () => {
        setEnvironment({ ci: "true", isTTY: false });
        assert.equal(isNonInteractive({}), true);
        assert.equal(isNonInteractive({ yes: false }), true);
    });

    it("stays interactive on a terminal outside CI without --yes", () => {
        setEnvironment({ ci: undefined, isTTY: true });
        assert.equal(isNonInteractive({}), false);
        assert.equal(isNonInteractive({ yes: false }), false);
    });

    it("lets --yes skip the wizard on a terminal outside CI", () => {
        setEnvironment({ ci: undefined, isTTY: true });
        assert.equal(isNonInteractive({ yes: true }), true);
    });
});
