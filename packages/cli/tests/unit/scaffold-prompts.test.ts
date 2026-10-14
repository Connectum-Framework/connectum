/**
 * Unit tests for the interactive wizard (task 2.1). The prompting logic is tested via
 * a stub Prompter (no @clack/prompts loaded), plus the non-interactive short-circuit.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { RawInput } from "../../src/scaffold/config.ts";
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

describe("isNonInteractive", () => {
    it("is true with --yes", () => {
        assert.equal(isNonInteractive({ yes: true }), true);
    });
});

describe("collectConfig", () => {
    it("short-circuits in non-interactive mode (returns flags unchanged)", async () => {
        const out = await collectConfig({ name: "svc", runtime: "bun", yes: true });
        assert.equal(out.name, "svc");
        assert.equal(out.runtime, "bun");
    });
});

describe("promptForMissing", () => {
    it("prompts for every field the flags did not provide", async () => {
        const { prompter, calls } = stubPrompter({ text: "myproj" });
        const out = await promptForMissing({}, prompter);
        assert.equal(out.name, "myproj");
        assert.equal(out.runtime, "node"); // first select option
        assert.equal(out.nodeExec, "raw"); // node -> node-exec asked
        assert.equal(out.packageManager, "pnpm");
        assert.ok(calls.includes("text:Project name"));
        assert.ok(calls.includes("select:Node execution model"));
        assert.ok(calls.includes("confirm:Add an EventBus?"));
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

describe("isNonInteractive: environment signals", () => {
    const originalCi = process.env.CI;
    const originalIsTTY = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");

    function setEnvironment(env: { ci: string | undefined; isTTY: boolean | undefined }): void {
        if (env.ci === undefined) {
            delete process.env.CI;
        } else {
            process.env.CI = env.ci;
        }
        Object.defineProperty(process.stdout, "isTTY", { value: env.isTTY, configurable: true, writable: true });
    }

    afterEach(() => {
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
    });

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
