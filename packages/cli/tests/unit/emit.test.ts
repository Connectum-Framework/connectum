/**
 * Unit tests for the file-emission layer (utils/emit).
 *
 * Covers path-safety (lexical traversal AND symlink containment), refuse-to-clobber
 * (default), force overwrite, deterministic ordering, and the all-or-nothing
 * validation guarantee.
 */

import assert from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { assertSafeRelativePath, emitFiles } from "../../src/utils/emit.ts";

describe("assertSafeRelativePath", () => {
    it("accepts a normal nested relative path", () => {
        assert.doesNotThrow(() => assertSafeRelativePath("src/services/foo.ts"));
    });

    it("rejects an empty path", () => {
        assert.throws(() => assertSafeRelativePath(""), /Unsafe emit path/);
    });

    it("rejects a POSIX absolute path", () => {
        assert.throws(() => assertSafeRelativePath("/etc/passwd"), /Unsafe emit path/);
    });

    it("rejects a Windows drive-absolute path", () => {
        assert.throws(() => assertSafeRelativePath("C:\\Windows\\x"), /Unsafe emit path/);
    });

    // A UNC path names a network share, so it is absolute on Windows. Its segments contain no
    // "..", no leading "/" and (apart from the empty ones) nothing else suspicious, so only an
    // explicit UNC rule keeps it out; the long-path prefix forms are the same escape.
    it("rejects a UNC path, including the long-path prefix forms", () => {
        assert.throws(() => assertSafeRelativePath("\\\\server\\share"), /Unsafe emit path/);
        assert.throws(() => assertSafeRelativePath("\\\\server\\share\\file.ts"), /Unsafe emit path/);
        assert.throws(() => assertSafeRelativePath("\\\\?\\C:\\x"), /Unsafe emit path/);
        assert.throws(() => assertSafeRelativePath("//server/share"), /Unsafe emit path/);
    });

    it("rejects parent traversal in any position", () => {
        assert.throws(() => assertSafeRelativePath("../escape.ts"), /Unsafe emit path/);
        assert.throws(() => assertSafeRelativePath("a/../../b"), /Unsafe emit path/);
        assert.throws(() => assertSafeRelativePath("a\\..\\b"), /Unsafe emit path/);
        assert.throws(() => assertSafeRelativePath(".."), /Unsafe emit path/);
        assert.throws(() => assertSafeRelativePath("a/.."), /Unsafe emit path/);
    });

    // Only a whole ".." segment is a traversal. A file name that merely contains two dots is a
    // legitimate name and must not be refused, otherwise valid generated files are lost.
    it("accepts names that only contain two dots", () => {
        for (const name of ["a..b", "..foo", "foo..", "src/v1..2/x.ts", "...", ".hidden/x"]) {
            assert.doesNotThrow(() => assertSafeRelativePath(name), name);
        }
    });
});

describe("emitFiles", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "connectum-emit-test-"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("writes files and creates parent directories", () => {
        const result = emitFiles(
            dir,
            new Map([
                ["package.json", "{}\n"],
                ["src/index.ts", "export {};\n"],
            ]),
        );
        assert.deepStrictEqual(result.written, ["package.json", "src/index.ts"]);
        assert.deepStrictEqual(result.skipped, []);
        assert.strictEqual(readFileSync(join(dir, "package.json"), "utf8"), "{}\n");
        assert.strictEqual(readFileSync(join(dir, "src/index.ts"), "utf8"), "export {};\n");
    });

    it("refuses to clobber an existing file by default", () => {
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src/index.ts"), "ORIGINAL");
        const result = emitFiles(
            dir,
            new Map([
                ["src/index.ts", "NEW"],
                ["src/new.ts", "NEW2"],
            ]),
        );
        assert.deepStrictEqual(result.skipped, ["src/index.ts"]);
        assert.deepStrictEqual(result.written, ["src/new.ts"]);
        assert.strictEqual(readFileSync(join(dir, "src/index.ts"), "utf8"), "ORIGINAL");
    });

    it("overwrites when force is set", () => {
        writeFileSync(join(dir, "a.txt"), "OLD");
        const result = emitFiles(dir, new Map([["a.txt", "NEW"]]), { force: true });
        assert.deepStrictEqual(result.written, ["a.txt"]);
        assert.strictEqual(readFileSync(join(dir, "a.txt"), "utf8"), "NEW");
    });

    // Connectum decision, no documented source: neither the guide nor the specs say in what order
    // the written paths are reported. The implementation sorts them so that the report (and the
    // order of writes) does not depend on the order the caller built its Map in; this test pins
    // exactly that independence from insertion order.
    it("Connectum decision (undocumented): reports written paths in sorted order, not insertion order", () => {
        const result = emitFiles(
            dir,
            new Map([
                ["z.txt", "z"],
                ["a.txt", "a"],
                ["m.txt", "m"],
            ]),
        );
        assert.deepStrictEqual(result.written, ["a.txt", "m.txt", "z.txt"]);
    });

    it("aborts before writing anything if any path is unsafe", () => {
        assert.throws(
            () =>
                emitFiles(
                    dir,
                    new Map([
                        ["ok.txt", "ok"],
                        ["../escape.txt", "bad"],
                    ]),
                ),
            /Unsafe emit path/,
        );
        // "ok.txt" must NOT have been written — validation runs before any write.
        assert.throws(() => readFileSync(join(dir, "ok.txt"), "utf8"));
    });

    it("refuses to write through a symlinked path component", () => {
        // Lexical validation alone is not enough: "linked/file.ts" contains no "..", but
        // mkdirSync/writeFileSync follow symlinks, so an existing symlinked component
        // would redirect the write outside the target directory.
        const outside = mkdtempSync(join(tmpdir(), "connectum-emit-outside-"));
        try {
            symlinkSync(outside, join(dir, "linked"), "dir");
            assert.throws(() => emitFiles(dir, new Map([["linked/file.ts", "x"]])), /symbolic link/);
            assert.equal(existsSync(join(outside, "file.ts")), false);
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });

    it("writes nothing when a later entry escapes through a symlink", () => {
        // Symlink containment must be part of the preflight, not the write loop: entries
        // are emitted in sorted order, so a per-write check would let "a.txt" land on disk
        // before "linked/file.ts" threw.
        const outside = mkdtempSync(join(tmpdir(), "connectum-emit-outside-"));
        try {
            symlinkSync(outside, join(dir, "linked"), "dir");
            assert.throws(
                () =>
                    emitFiles(
                        dir,
                        new Map([
                            ["a.txt", "safe"],
                            ["linked/file.ts", "escape"],
                        ]),
                    ),
                /symbolic link/,
            );
            assert.equal(existsSync(join(dir, "a.txt")), false);
            assert.equal(existsSync(join(outside, "file.ts")), false);
        } finally {
            rmSync(outside, { recursive: true, force: true });
        }
    });

    it("refuses to write when the target directory itself is a symlink", () => {
        const real = mkdtempSync(join(tmpdir(), "connectum-emit-real-"));
        const link = join(dir, "target-link");
        try {
            symlinkSync(real, link, "dir");
            assert.throws(() => emitFiles(link, new Map([["file.ts", "x"]])), /symbolic link/);
            assert.equal(existsSync(join(real, "file.ts")), false);
        } finally {
            rmSync(real, { recursive: true, force: true });
        }
    });
});
