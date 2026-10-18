/**
 * Runs the real `buf` (the CLI's own `@bufbuild/buf` dev dependency) over a project laid out in
 * a temporary directory. `buf` is the independent judge of whether the proto and `buf.yaml`
 * files the scaffolding emits are accepted: a name that is not defined, a lint rule that fires
 * or an unresolved import makes it fail, which a text comparison against the generator cannot.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const BUF = join(HERE, "../../node_modules/.bin/buf");
const AUTH_OPTIONS_PROTO = resolve(HERE, "../../../auth/proto/connectum/auth/v1/options.proto");
/** Where a generated project finds the auth option proto module (`AUTH_BUF_MODULE`). */
const AUTH_MODULE_DIR = "node_modules/@connectum/auth/proto/connectum/auth/v1";

/** Result of a `buf` run. */
export interface BufResult {
    /** Process exit status (0 = accepted). */
    status: number | null;
    /** Standard output and error of the run. */
    output: string;
}

/**
 * Lay `files` (relative path -> content) out in a fresh directory, add the auth option proto
 * module when `withAuthModule` is set, and run `buf <args>` there.
 */
export function runBuf(args: string[], files: ReadonlyMap<string, string>, options: { withAuthModule?: boolean } = {}): BufResult {
    const dir = mkdtempSync(join(tmpdir(), "connectum-buf-"));
    try {
        const all = new Map(files);
        if (options.withAuthModule === true) {
            all.set(`${AUTH_MODULE_DIR}/options.proto`, readFileSync(AUTH_OPTIONS_PROTO, "utf8"));
        }
        for (const [relPath, content] of all) {
            mkdirSync(dirname(join(dir, relPath)), { recursive: true });
            writeFileSync(join(dir, relPath), content);
        }
        const run = spawnSync(BUF, args, { cwd: dir, encoding: "utf8", timeout: 60_000 });
        // A missing binary or a timeout leaves status null; without this the rejection checks
        // (`status !== 0`) would pass although buf never ran.
        if (run.error !== undefined) {
            throw new Error(`buf could not run (${BUF}): ${run.error.message}`);
        }
        // A process killed by a signal has no exit status either and fails the same way.
        if (run.status === null) {
            throw new Error(`buf was terminated by ${run.signal ?? "an unknown signal"}`);
        }
        return { status: run.status, output: `${run.stdout ?? ""}${run.stderr ?? ""}` };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}
