/**
 * Runtime peer-version check.
 *
 * createServer() refuses to start when the protobuf / Connect copy core actually loaded
 * is outside core's peer ranges, because package managers do not all stop that at
 * install time (pnpm only warns, Bun can stay silent, Yarn leaves peers to the app).
 * These tests pin three things:
 * - the decision: which loaded versions fail, with the package, loaded version, required
 *   range and fix in the message;
 * - the "undeterminable means skip" rule, so a bundle or a runtime without
 *   import.meta.resolve never gets a false failure;
 * - the real environment: the workspace's own copies pass, under every engine this
 *   suite runs on (node, bun, esbuild loader).
 *
 * The fixture tree holds only manifests: the check reads `package.json` files found by
 * walking up from a resolved entry file, so the entry files themselves need not exist.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer, PeerDependencyVersionError } from "../../src/index.ts";
import { checkPeerVersions, satisfiesCaret } from "../../src/peerVersions.ts";

const FIXTURES = new URL("../fixtures/peer-versions/", import.meta.url);
/** A module inside the fixture "@connectum/core" package. */
const CORE_SELF = new URL("core/src/index.js", FIXTURES).href;

/** Resolver that maps each library to the entry file of a chosen fixture copy. */
function resolverFor(copies: Record<string, string>): (specifier: string) => string {
    return (specifier) => {
        const copy = copies[specifier];
        if (copy === undefined) throw new Error(`Cannot find package '${specifier}'`);
        return new URL(`libs/${copy}/esm/index.js`, FIXTURES).href;
    };
}

const IN_RANGE = {
    "@bufbuild/protobuf": "protobuf-2.16.0",
    "@connectrpc/connect": "connect-2.2.0",
    "@connectrpc/connect-node": "connect-node-2.2.0",
};

describe("checkPeerVersions — decision", () => {
    it("passes when every loaded copy is inside core's peer ranges", () => {
        const report = checkPeerVersions({ selfUrl: CORE_SELF, resolve: resolverFor(IN_RANGE) });
        assert.deepStrictEqual(report, { status: "checked", problems: [] });
    });

    it("reports a too-old protobuf with its loaded version, the required range and where it was loaded from", () => {
        const report = checkPeerVersions({ selfUrl: CORE_SELF, resolve: resolverFor({ ...IN_RANGE, "@bufbuild/protobuf": "protobuf-2.12.1" }) });
        assert.strictEqual(report.status, "checked");
        assert.deepStrictEqual(report.status === "checked" ? report.problems : undefined, [
            {
                packageName: "@bufbuild/protobuf",
                loadedVersion: "2.12.1",
                requiredRange: "^2.16.0",
                loadedFrom: fileURLToPath(new URL("libs/protobuf-2.12.1", FIXTURES)),
            },
        ]);
    });

    it("reports a too-old connect, the case Bun and pnpm let through with at most a warning", () => {
        const report = checkPeerVersions({ selfUrl: CORE_SELF, resolve: resolverFor({ ...IN_RANGE, "@connectrpc/connect": "connect-2.1.2" }) });
        assert.strictEqual(report.status === "checked" && report.problems.map((p) => `${p.packageName}@${p.loadedVersion}`).join(), "@connectrpc/connect@2.1.2");
    });

    it("skips the unnamed `{type: module}` marker next to the entry and reads the package's own manifest", () => {
        // Every fixture copy has esm/package.json without a name; a check that stopped at
        // the first package.json would find no version and silently pass a bad copy.
        const report = checkPeerVersions({ selfUrl: CORE_SELF, resolve: resolverFor({ ...IN_RANGE, "@bufbuild/protobuf": "protobuf-2.12.1" }) });
        assert.strictEqual(report.status === "checked" && report.problems.length, 1);
    });
});

describe("checkPeerVersions — undeterminable is skipped, never a failure", () => {
    it("skips when core is bundled: the nearest manifest above the running code is the application's", () => {
        const report = checkPeerVersions({ selfUrl: new URL("app/out/bundle.js", FIXTURES).href, resolve: resolverFor({ "@bufbuild/protobuf": "protobuf-2.12.1" }) });
        assert.strictEqual(report.status, "skipped");
    });

    it("skips when the module URL is missing (CommonJS bundle) or not a file URL", () => {
        assert.strictEqual(checkPeerVersions({ selfUrl: undefined, resolve: resolverFor(IN_RANGE) }).status, "skipped");
        assert.strictEqual(checkPeerVersions({ selfUrl: "data:text/javascript,", resolve: resolverFor(IN_RANGE) }).status, "skipped");
    });

    it("skips when the runtime has no import.meta.resolve", () => {
        assert.strictEqual(checkPeerVersions({ selfUrl: CORE_SELF, resolve: undefined }).status, "skipped");
    });

    it("ignores a library it cannot resolve or whose manifest belongs to another package", () => {
        const report = checkPeerVersions({
            selfUrl: CORE_SELF,
            resolve: resolverFor({ "@bufbuild/protobuf": "not-protobuf", "@connectrpc/connect": "connect-2.2.0" }),
        });
        assert.deepStrictEqual(report, { status: "checked", problems: [] });
    });
});

describe("satisfiesCaret", () => {
    const cases: [string, string, boolean | undefined][] = [
        ["2.16.0", "^2.16.0", true],
        ["2.16.7", "^2.16.0", true],
        ["2.17.0", "^2.16.0", true],
        ["2.15.9", "^2.16.0", false],
        ["2.12.1", "^2.16.0", false],
        ["3.0.0", "^2.16.0", false],
        ["1.10.1", "^2.16.0", false],
        ["2.16.0-rc.1", "^2.16.0", false],
        ["2.17.0-rc.1", "^2.16.0", false],
        ["2.16.0+build.1", "^2.16.0", true],
        // Ranges and versions the check does not understand are "unknown", never a failure.
        ["2.2.0", "2.2.0", undefined],
        ["0.2.1", "^0.2.0", undefined],
        ["2.16.0", ">=2.16.0", undefined],
        ["latest", "^2.16.0", undefined],
    ];
    for (const [version, range, expected] of cases) {
        it(`${version} vs ${range} -> ${expected}`, () => {
            assert.strictEqual(satisfiesCaret(version, range), expected);
        });
    }
});

describe("PeerDependencyVersionError", () => {
    it("names the package, the loaded version, the required range and the fix", () => {
        const error = new PeerDependencyVersionError([{ packageName: "@bufbuild/protobuf", loadedVersion: "2.12.1", requiredRange: "^2.16.0", loadedFrom: "/app/node_modules/@bufbuild/protobuf" }]);
        assert.strictEqual(error.name, "PeerDependencyVersionError");
        assert.ok(error instanceof Error);
        assert.match(error.message, /@bufbuild\/protobuf: loaded 2\.12\.1 \(from \/app\/node_modules\/@bufbuild\/protobuf\), @connectum\/core requires \^2\.16\.0/);
        assert.match(error.message, /npm install @bufbuild\/protobuf@"\^2\.16\.0"/);
        assert.match(error.message, /overrides/);
        assert.strictEqual(error.problems.length, 1);
    });
});

describe("createServer — real environment", () => {
    it("actually checks the installed copies (not skipped) and finds them in range", () => {
        // Guards against a check that silently skips everywhere: from core's source the
        // manifest is found and every library resolves to a readable copy.
        const report = checkPeerVersions({
            selfUrl: new URL("../../src/peerVersions.ts", import.meta.url).href,
            resolve: (specifier) => import.meta.resolve(specifier),
        });
        assert.deepStrictEqual(report, { status: "checked", problems: [] });
    });

    it("does not fail on the workspace's own in-range copies", () => {
        // Under node, bun and the esbuild loader alike: a false failure here would stop
        // every application from starting.
        assert.doesNotThrow(() => createServer({ services: [] }));
    });
});
