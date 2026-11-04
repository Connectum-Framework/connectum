import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { parse } from "yaml";

const root = resolve(import.meta.dirname, "../..");
const workflow = parse(readFileSync(join(root, ".github/workflows/release.yml"), "utf8"));
const steps = workflow.jobs.release.steps;
const publication = steps.find((step) => step.name === "Push proto to BSR");

test("every published release gets BSR labels, including releases without proto changes", () => {
    assert.equal(steps.find((step) => step.name === "Setup Buf CLI").if, "steps.changesets.outputs.published == 'true'");
    assert.equal(publication.if, "steps.changesets.outputs.published == 'true'");
    assert.equal(steps.some((step) => step.id === "proto-changes"), false);
    assert.equal(publication.env.BUF_TOKEN, "$" + "{{ secrets.BUF_TOKEN }}");
});

test("the release shell stages all current contracts byte-for-byte and labels v1.3.0", () => {
    const directory = mkdtempSync(join(tmpdir(), "connectum-bsr-release-"));
    try {
        for (const name of ["auth", "events"]) {
            const destination = join(directory, "packages", name);
            mkdirSync(destination, { recursive: true });
            cpSync(join(root, "packages", name, "proto"), join(destination, "proto"), { recursive: true });
        }
        // A newly added package must be discovered without extending a path allowlist.
        const future = join(directory, "packages/future/proto/connectum/future/v1/options.proto");
        mkdirSync(dirname(future), { recursive: true });
        writeFileSync(future, 'syntax = "proto3";\npackage connectum.future.v1;\nmessage FutureOptions {}\n');
        mkdirSync(join(directory, "packages/core"), { recursive: true });
        writeFileSync(join(directory, "packages/core/package.json"), '{"version":"1.3.0"}\n');
        mkdirSync(join(directory, "bin"));
        const mock = join(directory, "bin/buf");
        writeFileSync(mock, '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BSR_CALLS"\n');
        chmodSync(mock, 0o755);
        const script = publication.run
            .replaceAll("$" + "{{ github.ref_name }}", "main")
            .replaceAll("$" + "{{ github.sha }}", "release-commit");
        execFileSync("bash", ["-c", script], {
            cwd: directory,
            env: { ...process.env, PATH: `${join(directory, "bin")}:${process.env.PATH}`, BSR_CALLS: join(directory, "calls") },
        });
        for (const name of ["auth", "events", "future"]) {
            const source = join(directory, "packages", name, "proto/connectum", name, "v1/options.proto");
            const staged = join(directory, ".bsr/connectum/connectum", name, "v1/options.proto");
            assert.equal(readFileSync(staged, "utf8"), readFileSync(source, "utf8"), name);
        }
        assert.deepEqual(readdirSync(join(directory, ".bsr/connectum/connectum")).sort(), ["auth", "events", "future"]);
        const calls = readFileSync(join(directory, "calls"), "utf8").trim().split("\n");
        assert.equal(calls[0], "lint .bsr");
        assert.match(calls[1], /^push \.bsr --label main --source-control-url /);
        assert.match(calls[2], /^push \.bsr --label v1\.3\.0 --source-control-url /);
        assert.equal(calls.length, 3);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
