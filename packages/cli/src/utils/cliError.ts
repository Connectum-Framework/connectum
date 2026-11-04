/**
 * Errors the CLI expects and reports to the user as a single line.
 *
 * citty prints every error that reaches it as a raw object dump with a stack trace. That is the
 * right output for a defect in the CLI and the wrong one for a closed port, a mistyped address or
 * a missing `buf`: the user needs one sentence that names the address or file involved. An error
 * that is a {@link CliError} is such an expected failure; anything else is still a defect and
 * keeps its stack.
 *
 * @module utils/cliError
 */

/** A failure the user can fix, worded for the user: the message is printed as it is. */
export class CliError extends Error {
    constructor(message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "CliError";
    }
}

/**
 * Runs a command body. A {@link CliError} is printed as `Error: <message>` and ends the process
 * with exit code 1; any other error is rethrown, so citty reports it with its stack as before.
 *
 * The process is ended explicitly because an HTTP/2 session left over from a failed request would
 * keep it alive until the session's idle timeout, and waits for the stderr write so the message is
 * not lost when the stream is a pipe.
 */
export async function runReported(action: () => Promise<void>): Promise<void> {
    try {
        await action();
    } catch (error) {
        if (!(error instanceof CliError)) {
            throw error;
        }
        await new Promise<void>((resolve) => process.stderr.write(`Error: ${error.message}\n`, () => resolve()));
        process.exit(1);
    }
}
