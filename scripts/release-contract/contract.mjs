import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const CHANGESETS_ACTION_SHA = "198f833dd7d863100ea6e28967bc9a9fdefadb0a";

function sectionKeys(source, section) {
    const lines = source.split(/\r?\n/);
    const start = lines.indexOf(`${section}:`);
    if (start === -1) return new Set();
    const keys = new Set();
    for (const line of lines.slice(start + 1)) {
        if (/^\S/.test(line)) break;
        const match = line.match(/^ {2}([a-z][a-z0-9-]*):\s*$/);
        if (match) keys.add(match[1]);
    }
    return keys;
}

export function parseActionMetadata(source) {
    return {
        inputs: sectionKeys(source, "inputs"),
        outputs: sectionKeys(source, "outputs"),
    };
}

export function extractWorkflowContract(source) {
    const uses = source.match(/uses:\s*changesets\/action@([a-f0-9]{40})/);
    const lines = source.split(/\r?\n/);
    const actionLine = lines.findIndex((line) => /uses:\s*changesets\/action@/.test(line));
    let stepStart = actionLine;
    while (stepStart >= 0 && !/^\s{6}- /.test(lines[stepStart])) stepStart -= 1;
    let stepEnd = actionLine + 1;
    while (stepEnd < lines.length && !/^\s{6}- /.test(lines[stepEnd])) stepEnd += 1;
    const actionStep = lines.slice(stepStart, stepEnd).join("\n");
    const inputLines = actionStep.match(/^\s{10}([a-z][a-z0-9-]*):\s*(.+)$/gm) ?? [];
    const inputs = new Map(
        inputLines.map((line) => {
            const match = line.match(/^\s{10}([a-z][a-z0-9-]*):\s*(.+)$/);
            return [match[1], match[2].trim()];
        }),
    );
    const outputMatches = [...source.matchAll(/steps\.changesets\.outputs(?:\.([A-Za-z][A-Za-z0-9-]*)|\[['"]([A-Za-z][A-Za-z0-9-]*)['"]\])/g)];
    const outputs = new Set(outputMatches.map((match) => match[1] ?? match[2]));
    return { sha: uses?.[1], inputs, outputs, source };
}

export function validateWorkflowContract(options) {
    const { workflow, metadata, packageJson } = options;
    const errors = [];
    const action = parseActionMetadata(metadata);
    const contract = extractWorkflowContract(workflow);
    const requiredInputs = ["github-token", "version-script", "publish-script", "pr-title", "commit-message", "create-github-releases", "push-git-tags"];
    const requiredOutputs = ["published", "has-changesets", "pr-number"];

    if (contract.sha !== CHANGESETS_ACTION_SHA) errors.push(`changesets/action must be pinned to ${CHANGESETS_ACTION_SHA}`);
    for (const input of contract.inputs.keys()) {
        if (!action.inputs.has(input)) errors.push(`workflow uses unknown changesets/action input: ${input}`);
    }
    for (const input of requiredInputs) {
        if (!contract.inputs.has(input)) errors.push(`workflow is missing changesets/action input: ${input}`);
    }
    for (const output of contract.outputs) {
        if (!action.outputs.has(output)) errors.push(`workflow uses unknown changesets/action output: ${output}`);
    }
    for (const output of requiredOutputs) {
        if (!contract.outputs.has(output)) errors.push(`workflow does not consume changesets/action output: ${output}`);
    }
    const appTokenExpression = "$" + "{{ steps.app-token.outputs.token }}";
    if (contract.inputs.get("github-token") !== appTokenExpression) {
        errors.push("github-token must use the generated GitHub App token");
    }
    for (const input of ["create-github-releases", "push-git-tags"]) {
        if (contract.inputs.get(input) !== "false") errors.push(`${input} must be explicitly false`);
    }
    if (/\b(?:hasChangesets|pullRequestNumber|createGithubReleases)\b/.test(workflow)) {
        errors.push("workflow contains a legacy changesets/action v1 field");
    }
    if (/^\s{10}GITHUB_TOKEN:/m.test(workflow)) {
        errors.push("custom action authentication must use github-token, not action-step GITHUB_TOKEN");
    }
    const cliRange = packageJson.devDependencies?.["@changesets/cli"] ?? "";
    if (!/^\^?3\./.test(cliRange)) errors.push("@changesets/cli must use major version 3 with changesets/action v2");

    return errors;
}

function writeJson(path, value) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function exerciseChangesetsVersion(options) {
    const root = mkdtempSync(join(tmpdir(), "connectum-changesets-contract-"));
    try {
        writeJson(join(root, "package.json"), { private: true, packageManager: "pnpm@11.0.4" });
        writeFileSync(join(root, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
        writeJson(join(root, "packages/a/package.json"), { name: "@connectum/a", version: "1.0.0" });
        writeJson(join(root, "packages/b/package.json"), { name: "@connectum/b", version: "1.0.0" });
        writeJson(join(root, ".changeset/config.json"), {
            $schema: "https://unpkg.com/@changesets/config@3.1.1/schema.json",
            changelog: "@changesets/cli/changelog",
            commit: false,
            fixed: [["@connectum/*"]],
            linked: [],
            access: "public",
            baseBranch: "main",
            updateInternalDependencies: "patch",
            ignore: [],
        });
        writeFileSync(join(root, ".changeset/runtime-contract.md"), '---\n"@connectum/a": minor\n---\n\nValidate the disposable version plan.\n');
        execFileSync(process.execPath, [options.cliPath, "version"], { cwd: root, stdio: "pipe" });

        const a = JSON.parse(readFileSync(join(root, "packages/a/package.json"), "utf8"));
        const b = JSON.parse(readFileSync(join(root, "packages/b/package.json"), "utf8"));
        assert.equal(a.version, "1.1.0", "changed fixed-group package must receive the planned minor version");
        assert.equal(b.version, "1.1.0", "unchanged fixed-group package must receive the same version");
        assert.match(readFileSync(join(root, "packages/a/CHANGELOG.md"), "utf8"), /disposable version plan/i);
        assert.match(readFileSync(join(root, "packages/b/CHANGELOG.md"), "utf8"), /## 1\.1\.0/);
        return { versions: [a.version, b.version] };
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

export function localChangesetsCli(repoRoot) {
    return resolve(repoRoot, "node_modules/@changesets/cli/bin.js");
}
