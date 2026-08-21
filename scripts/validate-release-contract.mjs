import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { CHANGESETS_ACTION_SHA, exerciseChangesetsVersion, localChangesetsCli, validateWorkflowContract } from "./release-contract/contract.mjs";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const metadataUrl = `https://raw.githubusercontent.com/changesets/action/${CHANGESETS_ACTION_SHA}/action.yml`;
const response = await fetch(metadataUrl, {
    headers: { "user-agent": "connectum-release-contract" },
    signal: AbortSignal.timeout(15_000),
});
if (!response.ok) throw new Error(`Unable to load pinned changesets/action metadata: HTTP ${response.status}`);

const [workflow, packageJson] = await Promise.all([
    readFile(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8").then(JSON.parse),
]);
const errors = validateWorkflowContract({ workflow, metadata: await response.text(), packageJson });
if (errors.length > 0) {
    for (const error of errors) console.error(`release-contract: ${error}`);
    process.exitCode = 1;
} else {
    const plan = exerciseChangesetsVersion({ cliPath: localChangesetsCli(repoRoot) });
    console.log(`release-contract: action metadata and disposable fixed-group plan ${plan.versions.join("/")} validated`);
}
