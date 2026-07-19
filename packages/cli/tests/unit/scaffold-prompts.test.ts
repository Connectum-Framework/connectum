/**
 * Unit tests for the interactive wizard (task 2.1). The prompting logic is tested via
 * a stub Prompter (no @clack/prompts loaded), plus the non-interactive short-circuit.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
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

    it("asks for an adapter only when the user opts into events", async () => {
        const { prompter, calls } = stubPrompter({ confirm: { "Add an EventBus?": true }, select: { "Event adapter": "amqp" } });
        const out = await promptForMissing({}, prompter);
        assert.equal(out.events, "amqp");
        assert.ok(calls.includes("select:Event adapter"));
    });
});
