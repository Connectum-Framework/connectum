/**
 * Refusal of command-line flags a command does not define.
 *
 * citty parses leniently: a flag it does not know is not an error, it just lands in `args` next to
 * the known ones. For a scaffolder that is dangerous in a quiet way: `--evnts nats` produces a
 * project without events, and `--dryrun` on `proto sync` runs the real sync.
 *
 * @module utils/flags
 */

import { CliError } from "./cliError.ts";

/** The part of a citty argument definition this module reads. */
interface FlagDefinition {
    type: string;
    alias?: string | string[] | undefined;
}

/** `node-exec` -> `nodeExec`: citty exposes every kebab-case flag under both spellings. */
function camelCase(name: string): string {
    return name.replace(/-([a-z0-9])/g, (_match, letter: string) => letter.toUpperCase());
}

/** Names under which citty may store a defined flag in `args`. */
function knownKeys(definitions: Readonly<Record<string, FlagDefinition>>): Set<string> {
    const known = new Set<string>(["_"]);
    for (const [name, definition] of Object.entries(definitions)) {
        known.add(name);
        known.add(camelCase(name));
        for (const alias of [definition.alias ?? []].flat()) {
            known.add(alias);
        }
    }
    return known;
}

/** The flag as the user typed it: citty stores `--no-foo` as `foo: false`, so the raw arguments are consulted. */
function typedForm(key: string, rawArgs: readonly string[]): string {
    for (const raw of rawArgs) {
        if (raw === "--") {
            break;
        }
        const name = raw.startsWith("--") ? raw.slice(2).split("=")[0] : undefined;
        if (name === key || name === `no-${key}` || name === camelCase(key)) {
            return `--${name}`;
        }
    }
    return key.length === 1 ? `-${key}` : `--${key}`;
}

/**
 * Throws when the parsed arguments hold a flag the command does not define.
 *
 * @param command - Command name for the message (for example `connectum init`)
 * @param parsed - The `args` citty passes to `run`
 * @param rawArgs - The raw arguments, to show the flag the way it was typed
 * @param definitions - The command's citty argument definitions
 * @throws CliError naming the unknown flags and listing the valid ones
 */
export function assertKnownFlags(
    command: string,
    parsed: Readonly<Record<string, unknown>>,
    rawArgs: readonly string[],
    definitions: Readonly<Record<string, FlagDefinition>>,
): void {
    const known = knownKeys(definitions);
    const unknown = Object.keys(parsed)
        .filter((key) => !known.has(key))
        // citty also stores the kebab-case spelling of a camelCase flag; show each typed flag once.
        .map((key) => typedForm(key, rawArgs));
    if (unknown.length === 0) {
        return;
    }
    const valid = Object.entries(definitions)
        .filter(([, definition]) => definition.type !== "positional")
        .map(([name]) => `--${name}`);
    throw new CliError(`${command}: unknown option${unknown.length > 1 ? "s" : ""} ${[...new Set(unknown)].join(", ")}. Valid options: ${valid.join(", ")}.`);
}
