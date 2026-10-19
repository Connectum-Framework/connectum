/**
 * `proto sync` must either obtain a descriptor for every service the server lists or fail
 * with a non-zero exit and name what is missing, and it must give up on a server that never
 * answers. The servers here are hand-written reflection servers so the listing can disagree
 * with what the server can describe, which a real Reflection() mount never does.
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import type { Http2Server } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { executeProtoSync } from "../../src/commands/proto-sync.ts";
import { fetchFileDescriptorSetBinary, fetchReflectionData } from "../../src/utils/reflection.ts";
import { close, listen, partialReflectionServer, silentServer } from "../helpers/reflectionServers.ts";

describe("proto sync completeness and time limit", () => {
    let partial: Http2Server;
    let partialUrl: string;
    let silent: Http2Server;
    let silentUrl: string;
    let workdir: string;

    before(async () => {
        partial = partialReflectionServer();
        partialUrl = await listen(partial);
        silent = silentServer();
        silentUrl = await listen(silent);
        workdir = mkdtempSync(join(tmpdir(), "connectum-sync-complete-"));
    });

    after(async () => {
        await close(partial);
        await close(silent);
        rmSync(workdir, { recursive: true, force: true });
    });

    it("names every listed service that has no descriptor, in the registry fetch", async () => {
        await assert.rejects(
            () => fetchReflectionData(partialUrl),
            (err: Error) => /ghost\.v1\.GhostService/.test(err.message) && /empty\.v1\.EmptyService/.test(err.message) && !/FixtureService/.test(err.message),
        );
    });

    it("fails the binary descriptor-set fetch the same way", async () => {
        await assert.rejects(() => fetchFileDescriptorSetBinary(partialUrl), /ghost\.v1\.GhostService/);
    });

    it("fails a full sync before buf runs, so nothing is generated", async () => {
        const out = join(workdir, "full-out");
        await assert.rejects(() => executeProtoSync({ from: partialUrl, out }), /ghost\.v1\.GhostService/);
        assert.equal(existsSync(out), false);
    });

    it("fails a dry run with the same error", async () => {
        await assert.rejects(() => executeProtoSync({ from: partialUrl, out: join(workdir, "dry-out"), dryRun: true }), /empty\.v1\.EmptyService/);
    });

    it("gives up on a server that accepts the connection and never answers", async () => {
        const started = Date.now();
        await assert.rejects(
            () => fetchReflectionData(silentUrl, { timeoutMs: 500 }),
            (err: Error) => err.message.includes(silentUrl) && err.message.includes("500 ms"),
        );
        assert.ok(Date.now() - started < 5000, "the 500 ms limit must end the call within seconds");
    });

    it("applies the time limit to a full sync as well", async () => {
        await assert.rejects(() => executeProtoSync({ from: silentUrl, out: join(workdir, "silent-out"), timeoutMs: 300 }), /300 ms/);
    });
});

describe("proto sync --timeout validation", () => {
    // 100000000 has nine digits and cannot be carried by a grpc-timeout header; the literal is
    // written out so the test does not agree with whatever maximum the source holds.
    for (const bad of [0, -5, 1.5, Number.NaN, 100_000_000, 2 ** 31]) {
        it(`rejects ${bad} without opening a connection`, async () => {
            await assert.rejects(
                () => executeProtoSync({ from: "127.0.0.1:1", out: "unused", timeoutMs: bad }),
                (err: unknown) => err instanceof Error && /--timeout must be a positive integer/.test(err.message) && err.message.includes("at most 99999999"),
            );
        });
    }

    it("makes the reflection client itself refuse a limit above 99999999, for callers that bypass the command", async () => {
        await assert.rejects(
            () => fetchReflectionData("http://127.0.0.1:1", { timeoutMs: 100_000_000 }),
            (err: unknown) => err instanceof Error && err.message.includes("from 1 to 99999999 ms"),
        );
    });
});
