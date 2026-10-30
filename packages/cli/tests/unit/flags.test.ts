/**
 * Refusal of unknown flags: what citty leaves in `args` for a flag the command does not define,
 * and how the refusal words it. The parsing is citty's own (`parseArgs` over the real command
 * definitions), not a hand-made `args` object, so the shapes are the ones `run` receives.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type ArgsDef, parseArgs } from "citty";
import { CliError } from "../../src/utils/cliError.ts";
import { assertKnownFlags } from "../../src/utils/flags.ts";

const definitions = {
    name: { type: "positional", required: false },
    "node-exec": { type: "string" },
    events: { type: "string" },
    sample: { type: "boolean" },
    "dry-run": { type: "boolean", default: false },
    yes: { type: "boolean", alias: "y", default: false },
} as const satisfies ArgsDef;

function check(rawArgs: string[]): void {
    assertKnownFlags("connectum demo", parseArgs(rawArgs, definitions), rawArgs, definitions);
}

describe("assertKnownFlags", () => {
    it("accepts every defined flag in its kebab-case, camelCase, alias and negated spellings", () => {
        for (const rawArgs of [
            ["svc", "--node-exec", "tsx", "--events", "nats", "--dry-run"],
            ["--nodeExec=tsx", "--dryRun"],
            ["-y"],
            ["--no-sample"],
            ["--sample=false"],
            [],
        ]) {
            check(rawArgs);
        }
    });

    it("refuses a mistyped flag, naming it as typed and listing the valid ones", () => {
        assert.throws(
            () => check(["svc", "--evnts", "nats"]),
            (err: Error) =>
                err instanceof CliError &&
                err.message.startsWith("connectum demo: unknown option --evnts.") &&
                err.message.includes("--events") &&
                err.message.includes("--node-exec") &&
                err.message.includes("--dry-run") &&
                // the positional argument is not an option
                !err.message.includes("--name"),
        );
    });

    it("names a negated unknown flag the way it was typed", () => {
        assert.throws(
            () => check(["--no-evnts"]),
            (err: Error) => err.message.includes("unknown option --no-evnts."),
        );
    });

    it("names a mistyped flag that carries a value after = without the value", () => {
        assert.throws(
            () => check(["--dryrun=true"]),
            (err: Error) => err.message.includes("unknown option --dryrun.") && !err.message.includes("true"),
        );
    });

    it("names an unknown short flag with a single dash", () => {
        assert.throws(
            () => check(["-q"]),
            (err: Error) => err.message.includes("unknown option -q."),
        );
    });

    it("names every unknown flag, once each", () => {
        assert.throws(
            () => check(["--evnts", "nats", "--bogus", "--bogus"]),
            (err: Error) => err.message.includes("unknown options --evnts, --bogus."),
        );
    });
});
