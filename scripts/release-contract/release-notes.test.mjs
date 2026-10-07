import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = fileURLToPath(new URL("../build-release-notes.mjs", import.meta.url));
const packagesDir = fileURLToPath(new URL("./fixtures/release-notes/packages", import.meta.url));
const highlights = fileURLToPath(new URL("./fixtures/release-notes/highlights.md", import.meta.url));

function generate(...extra) {
    const run = spawnSync(process.execPath, [script, "1.0.0", "--packages-dir", packagesDir, "--highlights", highlights, ...extra], {
        encoding: "utf8",
    });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

const bytes = (text) => Buffer.byteLength(text, "utf8");
// The three sections in the order the generator prints them.
const sectionsOf = (text) => text.split(/\n(?=## )/);

const full = generate();
const [highlightsSection, repoWideSection, packagesSection] = sectionsOf(full.stdout);

test("fixture produces the three sections, so the cases below measure real section sizes", () => {
    assert.equal(full.status, 0);
    assert.match(highlightsSection, /^## Highlights/);
    assert.match(repoWideSection, /^## Repo-wide changes/);
    assert.match(packagesSection, /^## Package changes/);
    assert.ok(!full.stdout.includes("maintainer guidance"), "HTML comments of the highlights file must not leak");
});

test("a budget the notes fit in leaves the output unchanged", () => {
    const roomy = generate("--max-bytes", String(bytes(full.stdout)));
    assert.equal(roomy.stdout, full.stdout);
    assert.equal(roomy.stderr, "");
});

test("over budget, per-package changes go first and the reader is told where the full text is", () => {
    const budget = bytes(full.stdout) - 1;
    const cut = generate("--max-bytes", String(budget));
    assert.equal(cut.status, 0);
    assert.ok(bytes(cut.stdout) <= budget, `${bytes(cut.stdout)} bytes over the budget ${budget}`);
    assert.ok(cut.stdout.includes("Fixture highlight"));
    assert.ok(cut.stdout.includes("Raise the supported Node.js floor"), "repo-wide changes stay while they fit");
    assert.ok(!cut.stdout.includes("### @fixture/alpha"), "per-package entries are dropped");
    assert.match(cut.stdout, /## Package changes\n\n_Omitted: .*CHANGELOG\.md.*draft GitHub Release\._/s);
    assert.equal(cut.stderr, "");
});

test("when that is not enough, repo-wide changes go too and Highlights stays whole", () => {
    // Room for Highlights and the two one-line notes, but not for the repo-wide section.
    const budget = bytes(highlightsSection) + bytes(repoWideSection) - 1;
    const cut = generate("--max-bytes", String(budget));
    assert.equal(cut.status, 0);
    assert.ok(bytes(cut.stdout) <= budget, `${bytes(cut.stdout)} bytes over the budget ${budget}`);
    assert.ok(cut.stdout.includes("Fixture highlight"));
    assert.ok(!cut.stdout.includes("Raise the supported Node.js floor"));
    assert.equal(cut.stdout.match(/_Omitted:/g)?.length, 2, "each dropped section is replaced by one note");
});

test("Highlights longer than the budget is printed whole and the overrun is reported", () => {
    const cut = generate("--max-bytes", "1");
    assert.equal(cut.status, 0);
    assert.ok(cut.stdout.includes(highlightsSection.trimEnd()), "Highlights is never cut");
    assert.match(cut.stderr, /warning: .*over --max-bytes 1/);
});

test("the budget counts bytes, not characters", () => {
    assert.ok(highlightsSection.includes("—"), "the fixture must hold a multi-byte character");
    assert.ok(bytes(highlightsSection) > [...highlightsSection].length);
});

test("a budget that is not a positive integer is rejected", () => {
    for (const value of ["abc", "0", "-5", "1.5"]) {
        const run = generate("--max-bytes", value);
        assert.equal(run.status, 2, `--max-bytes ${value}`);
        assert.match(run.stderr, /--max-bytes must be a positive integer/);
    }
});
