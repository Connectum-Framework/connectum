/**
 * Runs the external gRPC clients of the interop suites.
 *
 * The clients live in the image defined by `docker/interop-tools/Dockerfile`
 * (build it with `node scripts/interop-tools.mjs`). They run with the host
 * network so they reach a server the test started on `localhost`, and the
 * upstream protos under `tests/interop/proto` are mounted read-only at
 * `/proto` for the exchanges that must not take their schema from the server.
 */

import { execFile, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Local tag of the tools image; `scripts/interop-tools.mjs` builds it. */
export const INTEROP_TOOLS_IMAGE = "connectum-interop-tools:local";

/** Directory of the vendored upstream protos, as seen inside the container. */
export const PROTO_DIR = "/proto";

const hostProtoDir = fileURLToPath(new URL("./proto", import.meta.url));

/** The clients the tools image provides. */
export type Tool = "grpcurl" | "buf" | "grpc_health_probe";

/** Directory, as seen inside the container, where a tool may write files (see `outDir`). */
export const OUT_DIR = "/out";

function dockerRunArgs(tool: Tool, args: readonly string[], outDir?: string): string[] {
    // With an output directory the tool runs as the current user, so the files
    // it writes there belong to the test and can be removed afterwards.
    const output = outDir === undefined ? [] : ["-v", `${outDir}:${OUT_DIR}`, "--user", `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`];
    return ["run", "--rm", "-i", "--network", "host", "-v", `${hostProtoDir}:${PROTO_DIR}:ro`, ...output, "--entrypoint", tool, INTEROP_TOOLS_IMAGE, ...args];
}

export interface ToolResult {
    /** Exit code of the tool; 0 on success. */
    code: number;
    stdout: string;
    stderr: string;
}

/**
 * Split grpcurl's output for a streaming call into its messages.
 *
 * grpcurl prints each message of a stream as one pretty-printed JSON object,
 * one after another with nothing between them but whitespace. A brace counter
 * that skips string contents finds where each object ends.
 */
export function parseJsonStream(output: string): unknown[] {
    const messages: unknown[] = [];
    let depth = 0;
    let start = -1;
    let inString = false;
    for (let i = 0; i < output.length; i++) {
        const char = output[i];
        if (inString) {
            if (char === "\\") {
                i++;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }
        if (char === '"') {
            inString = true;
        } else if (char === "{") {
            if (depth === 0) {
                start = i;
            }
            depth++;
        } else if (char === "}") {
            depth--;
            if (depth === 0) {
                messages.push(JSON.parse(output.slice(start, i + 1)));
            }
        }
    }
    if (depth !== 0) {
        throw new Error(`unterminated JSON message in tool output:\n${output}`);
    }
    return messages;
}

/**
 * Run one tool from the image and resolve with its exit code and output.
 *
 * A non-zero exit is a result, not an error: probes and failing calls are
 * checked by their exit code. Only a failure to start Docker rejects.
 * `outDir`, a host directory, is mounted writable at {@link OUT_DIR} for tools
 * that write files (grpcurl's `-protoset-out`).
 */
export function runTool(tool: Tool, args: readonly string[], options: { stdin?: string; outDir?: string } = {}): Promise<ToolResult> {
    return new Promise((resolve, reject) => {
        const child = execFile("docker", dockerRunArgs(tool, args, options.outDir), { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
            if (error && typeof error.code !== "number") {
                reject(error);
                return;
            }
            resolve({ code: typeof error?.code === "number" ? error.code : 0, stdout, stderr });
        });
        child.stdin?.end(options.stdin ?? "");
    });
}

export interface RunningTool {
    /** Resolve once the tool's stdout so far parses to at least `count` stream messages. */
    messages(count: number, timeoutMs: number): Promise<unknown[]>;
    /** Resolve when the tool exits. */
    done: Promise<ToolResult>;
}

/**
 * Start a tool for a streaming call and let the test react to its output while
 * it runs. A Health `Watch` needs this: the container takes about a second to
 * start, so the test must see the first message before it changes a status,
 * or the client may connect after the change and never observe it.
 */
export function startTool(tool: Tool, args: readonly string[]): RunningTool {
    const child = spawn("docker", dockerRunArgs(tool, args), { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin.end();
    let stdout = "";
    let stderr = "";
    const waiters = new Set<() => void>();
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
        for (const wake of waiters) {
            wake();
        }
    });
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
    });
    const done = new Promise<ToolResult>((resolve, reject) => {
        child.on("error", reject);
        child.on("close", (code) => {
            for (const wake of waiters) {
                wake();
            }
            resolve({ code: code ?? 1, stdout, stderr });
        });
    });
    return {
        done,
        messages(count, timeoutMs) {
            return new Promise((resolve, reject) => {
                const check = (): boolean => {
                    // Only complete objects are parsed: cut at the last closing
                    // brace at the start of a line, where grpcurl ends a message.
                    const end = stdout.lastIndexOf("\n}");
                    const parsed = end === -1 ? [] : parseJsonStream(stdout.slice(0, end + 2));
                    if (parsed.length >= count) {
                        waiters.delete(wake);
                        clearTimeout(timer);
                        resolve(parsed);
                        return true;
                    }
                    return false;
                };
                const wake = (): void => {
                    check();
                };
                const timer = setTimeout(() => {
                    waiters.delete(wake);
                    reject(new Error(`expected ${count} messages within ${timeoutMs} ms; stdout:\n${stdout}\nstderr:\n${stderr}`));
                }, timeoutMs);
                if (!check()) {
                    waiters.add(wake);
                }
            });
        },
    };
}
