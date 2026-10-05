/**
 * The emission layer checks every target before the first write: a refused emission must
 * leave the destination exactly as it was, and must name every conflicting path.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { emitFiles } from "../../src/utils/emit.ts";

const files = (...paths: string[]): Map<string, string> => new Map(paths.map((p) => [p, `content of ${p}`]));

describe("emitFiles: preflight of every target", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "connectum-emit-pre-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    for (const force of [false, true]) {
        const mode = force ? "with --force" : "without --force";

        it(`refuses a directory standing where a file is expected, writing nothing (${mode})`, () => {
            mkdirSync(join(dir, "package.json"));
            assert.throws(
                () => emitFiles(dir, files("README.md", "package.json", "src/index.ts"), { force }),
                (err: Error) => /package\.json/.test(err.message) && /is a directory/.test(err.message),
            );
            assert.deepEqual(readdirSync(dir), ["package.json"]);
        });

        it(`refuses a file standing where a directory is expected, writing nothing (${mode})`, () => {
            writeFileSync(join(dir, "src"), "i am a file");
            assert.throws(
                () => emitFiles(dir, files("README.md", "src/services/a.ts"), { force }),
                (err: Error) => /src\/services\/a\.ts/.test(err.message) && /"src" is a file/.test(err.message),
            );
            assert.deepEqual(readdirSync(dir), ["src"]);
        });

        it(`names every conflicting target in one message (${mode})`, () => {
            mkdirSync(join(dir, "package.json"));
            writeFileSync(join(dir, "src"), "file");
            assert.throws(
                () => emitFiles(dir, files("package.json", "src/a.ts", "src/b.ts"), { force }),
                (err: Error) => ["package.json", "src/a.ts", "src/b.ts"].every((p) => err.message.includes(p)),
            );
        });
    }

    it("writes a clean destination completely", () => {
        const result = emitFiles(dir, files("a.txt", "x/y/b.txt"));
        assert.deepEqual(result.written, ["a.txt", "x/y/b.txt"]);
        assert.deepEqual(result.skipped, []);
    });

    it("still skips an existing regular file without --force", () => {
        writeFileSync(join(dir, "a.txt"), "mine");
        const result = emitFiles(dir, files("a.txt", "b.txt"));
        assert.deepEqual(result.skipped, ["a.txt"]);
        assert.deepEqual(result.written, ["b.txt"]);
    });

    // A process with root rights ignores permission bits, so the check cannot be observed.
    const isRoot = typeof process.getuid === "function" && process.getuid() === 0;

    it("refuses an unwritable destination before writing, naming the directory", { skip: isRoot }, () => {
        mkdirSync(join(dir, "ro"));
        chmodSync(join(dir, "ro"), 0o555);
        try {
            assert.throws(
                () => emitFiles(dir, files("a.txt", "ro/inner/b.txt")),
                (err: Error) => /ro\/inner\/b\.txt/.test(err.message) && /not writable/.test(err.message),
            );
            assert.deepEqual(readdirSync(dir), ["ro"]);
        } finally {
            chmodSync(join(dir, "ro"), 0o755);
        }
    });

    it("refuses a read-only existing file with --force", { skip: isRoot }, () => {
        writeFileSync(join(dir, "locked.txt"), "x");
        chmodSync(join(dir, "locked.txt"), 0o444);
        assert.throws(
            () => emitFiles(dir, files("a.txt", "locked.txt"), { force: true }),
            (err: Error) => /locked\.txt/.test(err.message) && /not writable/.test(err.message),
        );
        assert.deepEqual(readdirSync(dir).sort(), ["locked.txt"]);
    });
});

describe("emitFiles: a destination that does not exist yet", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "connectum-emit-missing-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("is created together with its missing parents", () => {
        const dest = join(dir, "apps", "payments");
        const result = emitFiles(dest, files("package.json", "src/index.ts"), { force: false });
        assert.deepEqual([...result.written].sort(), ["package.json", "src/index.ts"]);
    });

    it("is refused, writing nothing, when a parent of the destination is a file", () => {
        writeFileSync(join(dir, "apps"), "i am a file");
        assert.throws(() => emitFiles(join(dir, "apps", "payments"), files("package.json"), { force: false }), /a parent of the destination, is not a directory/);
        assert.deepEqual(readdirSync(dir), ["apps"]);
    });
});
