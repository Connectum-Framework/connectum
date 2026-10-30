/**
 * What `connectum init --no-healthcheck` takes out of the fetched base besides the protocol in
 * `src/server.ts`: the container `HEALTHCHECK` that probes `/healthz`, and the `curl` it needs.
 * Left in, a Dockerfile of a project without the health protocol would declare the container
 * unhealthy as soon as its start period ends (`/healthz` answers 404), and an orchestrator would
 * restart a service that works.
 *
 * Implemented as a line scan, like the auth annotation: the input is a file fetched at runtime.
 *
 * @module scaffold/healthcheckFragment
 */

/** The npm package that provides the health protocol. */
export const HEALTHCHECK_PACKAGE = "@connectum/healthcheck";

/**
 * The base's instruction that installs `curl` and nothing else. Matched whole, so a line that
 * installs further packages is never taken for it and removed with them.
 */
const CURL_ONLY_INSTALL = "RUN apt-get update && apt-get install -y --no-install-recommends curl && rm -rf /var/lib/apt/lists/*";

/** Whether `line` is part of the comment block that explains the instruction right below it. */
function isComment(line: string): boolean {
    return line.trimStart().startsWith("#");
}

/**
 * Index of the last line of the instruction that starts at `start`: an instruction continues
 * while a line ends with a backslash.
 */
function instructionEnd(lines: readonly string[], start: number): number {
    let end = start;
    while (end < lines.length - 1 && (lines[end] ?? "").trimEnd().endsWith("\\")) {
        end += 1;
    }
    return end;
}

/**
 * Remove, from a Dockerfile of the base, the `HEALTHCHECK` instruction and the `curl` install that
 * exists only to run it, each with the comment lines directly above it.
 *
 * @param source - The fetched Dockerfile
 * @returns The Dockerfile without the health probe
 * @throws Error if a `HEALTHCHECK` is still there after the removal, which means the base was
 *   written in a form this scan does not know: refusing is better than emitting a container that
 *   reports itself unhealthy.
 */
export function removeContainerHealthcheck(source: string): string {
    const lines = source.split("\n");
    const isInstruction = (line: string, keyword: string): boolean => line.trimStart().toUpperCase().startsWith(`${keyword} `);

    for (const matches of [(line: string) => isInstruction(line, "HEALTHCHECK"), (line: string) => line.trim() === CURL_ONLY_INSTALL]) {
        const at = lines.findIndex(matches);
        if (at === -1) {
            continue;
        }
        let first = at;
        while (first > 0 && isComment(lines[first - 1] ?? "")) {
            first -= 1;
        }
        lines.splice(first, instructionEnd(lines, at) - first + 1);
    }

    if (lines.some((line) => isInstruction(line, "HEALTHCHECK"))) {
        throw new Error(
            "connectum init: could not remove the container HEALTHCHECK from the Dockerfile of the fetched base — it is written in a form the CLI does not recognise. Re-run without --no-healthcheck, or open an issue: the base example and the CLI have drifted.",
        );
    }
    return lines.join("\n");
}
