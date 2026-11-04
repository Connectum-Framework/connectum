// Gate check — package metadata that the npm package page and `npm bugs` /
// `npm docs` / `npm repo` read from the packed manifest.
//
// The manifest is edited by hand in 15 places, so a field can be missing in one
// package or spelled differently in another (the event adapters once used a
// `repository.url` without the `git+` prefix). Only the installed copy shows
// what a consumer gets, so this check reads each installed `@connectum/*`
// manifest and compares it with the one expected value per package:
//   homepage          the package page of the documentation site
//   bugs.url          the issue tracker of the repository
//   repository        type "git", the shared repository URL and the package directory
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const NM = resolve("node_modules", "@connectum");
const ISSUES_URL = "https://github.com/Connectum-Framework/connectum/issues";
const REPOSITORY_URL = "git+https://github.com/Connectum-Framework/connectum.git";

const pkgs = readdirSync(NM)
    .filter((d) => existsSync(join(NM, d, "package.json")))
    .sort();

let fail = 0;
const expectEqual = (pkg, field, actual, expected) => {
    if (actual !== expected) {
        fail++;
        console.log(`XX @connectum/${pkg} ${field}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    }
};

for (const pkg of pkgs) {
    const pj = JSON.parse(readFileSync(join(NM, pkg, "package.json"), "utf8"));
    expectEqual(pkg, "homepage", pj.homepage, `https://connectum.dev/en/packages/${pkg}`);
    expectEqual(pkg, "bugs.url", pj.bugs?.url, ISSUES_URL);
    expectEqual(pkg, "repository.type", pj.repository?.type, "git");
    expectEqual(pkg, "repository.url", pj.repository?.url, REPOSITORY_URL);
    expectEqual(pkg, "repository.directory", pj.repository?.directory, `packages/${pkg}`);
}

console.log(`\nmanifest metadata: ${pkgs.length} packages checked, ${fail} mismatch(es)`);
process.exit(fail === 0 ? 0 : 1);
