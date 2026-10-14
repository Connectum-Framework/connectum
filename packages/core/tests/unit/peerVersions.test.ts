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
import { createRequire } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { createServer, PeerDependencyVersionError } from "../../src/index.ts";
import { checkPeerVersions, satisfiesCaret, satisfiesPeerRange } from "../../src/peerVersions.ts";

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
                kind: "range",
                requiredBy: "@connectum/core",
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
        // A version that is not plain semver is "unknown", never a failure.
        ["latest", "^2.16.0", undefined],
    ];
    for (const [version, range, expected] of cases) {
        it(`${version} vs ${range} -> ${expected}`, () => {
            assert.strictEqual(satisfiesCaret(version, range), expected);
        });
    }
});

/**
 * Pairs whose answer is fixed by the semver range grammar (node-semver and semver.org),
 * for range forms core's own caret check does not evaluate: an exact version, a caret
 * with a zero major, and a `>=` comparator. Derived by hand from the grammar, not from
 * the implementation:
 *   - `X.Y.Z` is equality;
 *   - `^0.Y.Z` (Y > 0) means `>=0.Y.Z <0.(Y+1).0`;
 *   - `>=X.Y.Z` means every version at or above it.
 */
const semverTruth: [version: string, range: string, satisfies: boolean][] = [
    ["2.2.0", "2.2.0", true],
    ["2.2.1", "2.2.0", false],
    ["0.2.1", "^0.2.0", true],
    ["0.3.0", "^0.2.0", false],
    ["0.1.9", "^0.2.0", false],
    ["2.16.0", ">=2.16.0", true],
    ["3.0.0", ">=2.16.0", true],
    ["2.15.9", ">=2.16.0", false],
];

describe("satisfiesCaret — ranges outside the caret form it evaluates", () => {
    // Independent oracle: whatever the function answers for a range it does not
    // evaluate must never contradict semver. "Unknown" (undefined) is allowed; `true`
    // where semver says `false`, or the reverse, would let a bad copy through or
    // reject a good one and is a defect.
    for (const [version, range, satisfies] of semverTruth) {
        it(`${version} vs ${range}: unknown or exactly what semver says (${satisfies})`, () => {
            const answer = satisfiesCaret(version, range);
            assert.ok(answer === undefined || answer === satisfies, `got ${answer}, semver says ${satisfies}`);
        });
    }

    // Connectum decision, no documented source beyond the function's own JSDoc: the
    // check evaluates only the caret form core publishes (`^X.Y.Z`, X >= 1); any other
    // range is "unknown" and the caller skips that library instead of guessing. The
    // semver answer for these pairs is `true`, so this pins a deliberately conservative
    // choice: no failure is ever raised on a range the check does not understand.
    for (const [version, range] of [
        ["2.2.0", "2.2.0"],
        ["0.2.1", "^0.2.0"],
        ["2.16.0", ">=2.16.0"],
    ] as const) {
        it(`${version} vs ${range} is deliberately unknown, so it can never fail the application`, () => {
            assert.strictEqual(satisfiesCaret(version, range), undefined);
        });
    }
});

describe("PeerDependencyVersionError", () => {
    it("names the package, the loaded version, the required range and the fix", () => {
        const error = new PeerDependencyVersionError([
            { kind: "range", packageName: "@bufbuild/protobuf", loadedVersion: "2.12.1", requiredRange: "^2.16.0", requiredBy: "@connectum/core", loadedFrom: "/app/node_modules/@bufbuild/protobuf" },
        ]);
        assert.strictEqual(error.name, "PeerDependencyVersionError");
        assert.ok(error instanceof Error);
        assert.match(error.message, /@bufbuild\/protobuf: loaded 2\.12\.1 \(from \/app\/node_modules\/@bufbuild\/protobuf\), @connectum\/core requires \^2\.16\.0/);
        assert.match(error.message, /npm install @bufbuild\/protobuf@"\^2\.16\.0"/);
        assert.match(error.message, /overrides/);
        assert.strictEqual(error.problems.length, 1);
        assert.doesNotMatch(error.message, /connect-node works only/);
    });

    it("explains lockstep when connect-node's connect is the problem", () => {
        const error = new PeerDependencyVersionError([
            {
                kind: "split",
                packageName: "@connectrpc/connect",
                loadedVersion: "2.2.0",
                requiredRange: "2.2.0",
                requiredBy: "@connectrpc/connect-node@2.2.0",
                loadedFrom: "/app/node_modules/@connectrpc/connect-node/node_modules/@connectrpc/connect",
                otherCopy: "/app/node_modules/@connectrpc/connect",
            },
        ]);
        assert.match(error.message, /@connectrpc\/connect-node@2\.2\.0 loads 2\.2\.0 from .*, a different copy than @connectum\/core loads \(\/app\/node_modules\/@connectrpc\/connect\)/);
        assert.match(error.message, /keep both on the same version, with a single copy/);
    });

    it("never advises installing connect-node's exact connect when it contradicts core's range", () => {
        const error = new PeerDependencyVersionError([
            { kind: "range", packageName: "@connectrpc/connect-node", loadedVersion: "2.1.2", requiredRange: "^2.2.0", requiredBy: "@connectum/core", loadedFrom: "/app/cn" },
            { kind: "range", packageName: "@connectrpc/connect", loadedVersion: "2.2.0", requiredRange: "2.1.2", requiredBy: "@connectrpc/connect-node@2.1.2", loadedFrom: "/app/c" },
        ]);
        assert.match(error.message, /npm install @connectrpc\/connect-node@"\^2\.2\.0",/);
        assert.doesNotMatch(error.message, /@connectrpc\/connect@"2\.1\.2"/);
    });
});

/**
 * A `resolveFrom` that answers "which @connectrpc/connect does connect-node load" with a
 * chosen fixture copy, and fails loudly for any other question.
 */
function connectNodeLoads(copy: string): (fromUrl: string, specifier: string) => string {
    return (fromUrl, specifier) => {
        assert.match(fromUrl, /libs\/connect-node-[^/]+\/esm\/index\.js$/, "resolves from connect-node's own entry");
        assert.strictEqual(specifier, "@connectrpc/connect");
        return fileURLToPath(new URL(`libs/${copy}/esm/index.js`, FIXTURES));
    };
}

describe("checkPeerVersions — connect / connect-node lockstep", () => {
    it("passes when connect-node loads the exact connect it declares, and it is core's copy", () => {
        const report = checkPeerVersions({ selfUrl: CORE_SELF, resolve: resolverFor(IN_RANGE), resolveFrom: connectNodeLoads("connect-2.2.0") });
        assert.deepStrictEqual(report, { status: "checked", problems: [] });
    });

    it("fails when connect-node declares another exact connect, although both are inside core's ranges", () => {
        // connect-node 2.2.5 requires connect exactly 2.2.5; core's ^2.2.0 accepts both,
        // so only the lockstep check sees this pair — the case Bun and Yarn install silently.
        const report = checkPeerVersions({
            selfUrl: CORE_SELF,
            resolve: resolverFor({ ...IN_RANGE, "@connectrpc/connect-node": "connect-node-2.2.5" }),
            resolveFrom: connectNodeLoads("connect-2.2.0"),
        });
        assert.deepStrictEqual(report.status === "checked" ? report.problems : undefined, [
            {
                kind: "range",
                packageName: "@connectrpc/connect",
                loadedVersion: "2.2.0",
                requiredRange: "2.2.5",
                requiredBy: "@connectrpc/connect-node@2.2.5",
                loadedFrom: fileURLToPath(new URL("libs/connect-2.2.0", FIXTURES)),
            },
        ]);
    });

    it("fails when connect-node loads a different connect copy than core, even at the same version", () => {
        const report = checkPeerVersions({ selfUrl: CORE_SELF, resolve: resolverFor(IN_RANGE), resolveFrom: connectNodeLoads("connect-2.2.0-second-copy") });
        assert.deepStrictEqual(report.status === "checked" ? report.problems : undefined, [
            {
                kind: "split",
                packageName: "@connectrpc/connect",
                loadedVersion: "2.2.0",
                requiredRange: "2.2.0",
                requiredBy: "@connectrpc/connect-node@2.2.0",
                loadedFrom: fileURLToPath(new URL("libs/connect-2.2.0-second-copy", FIXTURES)),
                otherCopy: fileURLToPath(new URL("libs/connect-2.2.0", FIXTURES)),
            },
        ]);
    });

    it("skips the lockstep part when connect-node's connect cannot be resolved or resolveFrom is missing", () => {
        const throwing = () => {
            throw new Error("Cannot find module '@connectrpc/connect'");
        };
        assert.deepStrictEqual(checkPeerVersions({ selfUrl: CORE_SELF, resolve: resolverFor(IN_RANGE), resolveFrom: throwing }), { status: "checked", problems: [] });
        assert.deepStrictEqual(checkPeerVersions({ selfUrl: CORE_SELF, resolve: resolverFor(IN_RANGE) }), { status: "checked", problems: [] });
    });
});

describe("satisfiesPeerRange", () => {
    const cases: [string, string, boolean | undefined][] = [
        ["2.2.0", "2.2.0", true],
        ["2.2.0+build.7", "2.2.0", true],
        ["2.2.1", "2.2.0", false],
        ["2.1.2", "2.2.0", false],
        ["2.2.0-rc.1", "2.2.0", false],
        ["2.2.0", "^2.2.0", true],
        ["latest", "2.2.0", undefined],
    ];
    for (const [version, range, expected] of cases) {
        it(`${version} vs ${range} -> ${expected}`, () => {
            assert.strictEqual(satisfiesPeerRange(version, range), expected);
        });
    }

    // Independent oracle: for a `>=` range (not evaluated) the answer is unknown or
    // exactly semver's, never the opposite. `>=X.Y.Z` accepts every version at or above.
    for (const [version, range, satisfies] of [
        ["2.2.0", ">=2.2.0", true],
        ["2.3.1", ">=2.2.0", true],
        ["2.1.2", ">=2.2.0", false],
    ] as const) {
        it(`${version} vs ${range}: unknown or exactly what semver says (${satisfies})`, () => {
            const answer = satisfiesPeerRange(version, range);
            assert.ok(answer === undefined || answer === satisfies, `got ${answer}, semver says ${satisfies}`);
        });
    }

    // Connectum decision, no documented source beyond the function's own JSDoc: only an
    // exact version or a caret range is evaluated; `>=2.2.0` is "unknown" and skipped
    // rather than guessed, although semver would answer `true`.
    it("2.2.0 vs >=2.2.0 is deliberately unknown, so it can never fail the application", () => {
        assert.strictEqual(satisfiesPeerRange("2.2.0", ">=2.2.0"), undefined);
    });
});

describe("checkPeerVersions — a connect-node peer range of a form the check does not evaluate", () => {
    // The same decision seen from the application: connect-node publishes its connect
    // peer as `>=2.2.0` (not an exact version). The lockstep range check cannot judge it
    // and must stay silent, so createServer() is not stopped by a range it cannot read.
    // The copy-identity part of the lockstep check is independent of the range form and
    // still runs: the same single connect copy passes.
    it("reports no problem for an open-ended connect-node peer when both load the same connect copy", () => {
        const report = checkPeerVersions({
            selfUrl: CORE_SELF,
            resolve: resolverFor({ ...IN_RANGE, "@connectrpc/connect-node": "connect-node-open-peer" }),
            resolveFrom: connectNodeLoads("connect-2.2.0"),
        });
        assert.deepStrictEqual(report, { status: "checked", problems: [] });
    });
});

describe("createServer — real environment", () => {
    it("actually checks the installed copies (not skipped) and finds them in range", () => {
        // Guards against a check that silently skips everywhere: from core's source the
        // manifest is found and every library resolves to a readable copy.
        const report = checkPeerVersions({
            selfUrl: new URL("../../src/peerVersions.ts", import.meta.url).href,
            resolve: (specifier) => import.meta.resolve(specifier),
            resolveFrom: (fromUrl, specifier) => createRequire(fromUrl).resolve(specifier),
        });
        assert.deepStrictEqual(report, { status: "checked", problems: [] });
    });

    it("does not fail on the workspace's own in-range copies", () => {
        // Under node, bun and the esbuild loader alike: a false failure here would stop
        // every application from starting.
        assert.doesNotThrow(() => createServer({ services: [] }));
    });
});
