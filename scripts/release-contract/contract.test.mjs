import assert from "node:assert/strict";
import { test } from "node:test";
import { validateWorkflowContract } from "./contract.mjs";

const metadata = `
inputs:
  github-token:
  version-script:
  publish-script:
  pr-title:
  commit-message:
  create-github-releases:
  push-git-tags:
outputs:
  published:
  has-changesets:
  pr-number:
`;

const validWorkflow = `
jobs:
  release:
    steps:
      - name: Release
        id: changesets
        uses: changesets/action@198f833dd7d863100ea6e28967bc9a9fdefadb0a
        with:
          github-token: \${{ steps.app-token.outputs.token }}
          version-script: pnpm changeset:version
          publish-script: pnpm changeset:publish
          pr-title: Version Packages
          commit-message: Version Packages
          create-github-releases: false
          push-git-tags: false
      - if: steps.changesets.outputs.published == 'true'
      - if: steps.changesets.outputs['has-changesets'] == 'true'
      - run: echo \${{ steps.changesets.outputs['pr-number'] }}
`;

const packageJson = { devDependencies: { "@changesets/cli": "^3.0.0" } };

test("accepts the pinned action v2 contract", () => {
    assert.deepEqual(validateWorkflowContract({ workflow: validWorkflow, metadata, packageJson }), []);
});

for (const legacy of ["version", "publish", "createGithubReleases"]) {
    test(`rejects stale input ${legacy}`, () => {
        const workflow = validWorkflow.replace("          version-script: pnpm changeset:version\n", `          ${legacy}: stale\n`);
        assert.ok(validateWorkflowContract({ workflow, metadata, packageJson }).length > 0);
    });
}

for (const legacy of ["hasChangesets", "pullRequestNumber"]) {
    test(`rejects stale output ${legacy}`, () => {
        const workflow = validWorkflow.replace("has-changesets", legacy);
        assert.ok(validateWorkflowContract({ workflow, metadata, packageJson }).some((error) => error.includes(legacy)));
    });
}

test("rejects missing GitHub App token wiring", () => {
    const workflow = validWorkflow.replace("$" + "{{ steps.app-token.outputs.token }}", "$" + "{{ github.token }}");
    assert.ok(validateWorkflowContract({ workflow, metadata, packageJson }).some((error) => error.includes("GitHub App token")));
});

test("rejects a pinned decoy before an unpinned changesets step", () => {
    const unpinnedWorkflow = validWorkflow.replace("uses: changesets/action@198f833dd7d863100ea6e28967bc9a9fdefadb0a", "uses: changesets/action@v2");
    const workflow = unpinnedWorkflow.replace(
        "      - name: Release\n",
        "      - name: Decoy\n        uses: changesets/action@198f833dd7d863100ea6e28967bc9a9fdefadb0a\n      - name: Release\n",
    );

    assert.ok(validateWorkflowContract({ workflow, metadata, packageJson }).some((error) => error.includes("must be pinned")));
});

test("rejects duplicate changesets step ids", () => {
    const workflow = validWorkflow.replace("      - name: Release\n", "      - id: changesets\n        uses: example/action@v1\n      - name: Release\n");

    assert.ok(validateWorkflowContract({ workflow, metadata, packageJson }).some((error) => error.includes("exactly one step")));
});

for (const input of ["create-github-releases", "push-git-tags"]) {
    test(`rejects enabled ${input}`, () => {
        const workflow = validWorkflow.replace(`${input}: false`, `${input}: true`);
        assert.ok(validateWorkflowContract({ workflow, metadata, packageJson }).some((error) => error.includes(`${input} must be explicitly false`)));
    });
}
