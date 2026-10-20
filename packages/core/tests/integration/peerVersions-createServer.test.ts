/**
 * `createServer()` refuses to start on a protobuf / Connect copy outside core's peer
 * ranges.
 *
 * The decision itself is covered by the unit tests of the check. What they cannot
 * show is that `createServer()` runs the check on the copies the process really loaded
 * and lets its failure reach the caller: that is the one promise a package manager
 * that only warns depends on. Each case therefore starts a fresh Node.js process (the
 * check is cached per process) in which only the version check sees a chosen fixture
 * copy, and calls the public `createServer()`.
 */

import assert from "node:assert";
import { spawnSync } from "node:child_process";
import * as nodeModule from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const PRELOAD = new URL("../fixtures/peer-versions/redirectPeerResolution.mjs", import.meta.url);
const SRC_INDEX = new URL("../../src/index.ts", import.meta.url);
const LIBS = new URL("../fixtures/peer-versions/libs/", import.meta.url);

/** Entry file URL of a fixture copy, as `import.meta.resolve` would report it. */
const entryOf = (copy: string): string => new URL(`${copy}/esm/index.js`, LIBS).href;

/** What `createServer()` threw in a child process whose version check sees the given copies; `null` when it returned a server. */
function thrownByCreateServer(redirects: Record<string, string>): { name: string; message: string } | null {
    const program = `
        import { createServer } from ${JSON.stringify(SRC_INDEX.href)};
        try {
            createServer({ services: [] });
            console.log(JSON.stringify(null));
        } catch (error) {
            console.log(JSON.stringify({ name: error.name, message: error.message }));
        }
    `;
    const child = spawnSync(process.execPath, ["--import", fileURLToPath(PRELOAD), "--input-type=module", "-e", program], {
        encoding: "utf8",
        env: { ...process.env, PEER_RESOLUTION_MAP: JSON.stringify(redirects) },
    });
    assert.strictEqual(child.status, 0, `the child process failed: ${child.stderr}`);
    return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "");
}

// The preload relies on synchronous module resolution hooks (`module.registerHooks`), which Bun and
// older Node.js lines do not have. A namespace import keeps the missing export from failing the file
// before the skip condition is evaluated.
const skip = typeof nodeModule.registerHooks !== "function" ? "module.registerHooks is not available in this runtime" : false;

describe("createServer — peer version check on the loaded copies", { skip }, () => {
    it("creates the server when the check sees in-range copies", () => {
        assert.strictEqual(thrownByCreateServer({}), null);
    });

    it("throws PeerDependencyVersionError naming a too-old protobuf, its loaded version and the required range", () => {
        const thrown = thrownByCreateServer({ "@bufbuild/protobuf": entryOf("protobuf-2.12.1") });

        assert.ok(thrown, "createServer() must refuse a too-old protobuf");
        assert.strictEqual(thrown.name, "PeerDependencyVersionError");
        assert.match(thrown.message, /@bufbuild\/protobuf: loaded 2\.12\.1/);
        assert.match(thrown.message, /requires \^2\.16\.0/);
    });

    it("throws PeerDependencyVersionError naming a too-old connect, its loaded version and the required range", () => {
        const thrown = thrownByCreateServer({ "@connectrpc/connect": entryOf("connect-2.1.2") });

        assert.ok(thrown, "createServer() must refuse a too-old connect");
        assert.strictEqual(thrown.name, "PeerDependencyVersionError");
        assert.match(thrown.message, /@connectrpc\/connect: loaded 2\.1\.2/);
        assert.match(thrown.message, /requires \^2\.2\.0/);
    });
});
