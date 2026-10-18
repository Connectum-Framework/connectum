/**
 * Unit tests for the `connectum init` base transform (pure, no network).
 *
 * Validates config resolution, script/devDep synthesis (lifecycle-fix,
 * package-manager independence, runtime variance), the in-process e2e test
 * generation (D-7), and the whole-tree transform.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Code, ConnectError } from "@connectrpc/connect";
import ts from "typescript";
import { resolveConfig } from "../../src/scaffold/config.ts";
import {
    buildDevDeps,
    buildScripts,
    generateGreeterE2eTest,
    transformBase,
    transformPackageJson,
} from "../../src/scaffold/transform.ts";
import type { ScaffoldConfig } from "../../src/scaffold/types.ts";
import { GREETER_PROTO } from "../helpers/baseFixture.ts";
import { argumentsOf, callsTo, collectNodes, importsOf, parseGenerated, protoRpcMethods, unresolvedWorkspaceImports } from "../helpers/generatedCode.ts";

const nodePnpm: ScaffoldConfig = { dir: "payments", name: "payments", runtime: "node", packageManager: "pnpm", nodeExec: "raw", sample: true, modules: {} };

describe("resolveConfig", () => {
    it("applies defaults", () => {
        const cfg = resolveConfig({ name: "svc" });
        assert.deepEqual(cfg, {
            dir: "svc",
            name: "svc",
            runtime: "node",
            packageManager: "pnpm",
            nodeExec: "raw",
            sample: true,
            modules: { otel: false, events: undefined, auth: false, resilience: [], healthcheck: true, reflection: true, catalog: false },
        });
    });

    it("requires a name", () => {
        assert.throws(() => resolveConfig({}), /project name is required/);
        assert.throws(() => resolveConfig({ name: "  " }), /project name is required/);
    });

    it("rejects invalid enum values", () => {
        assert.throws(() => resolveConfig({ name: "x", runtime: "deno" }), /invalid --runtime/);
        assert.throws(() => resolveConfig({ name: "x", packageManager: "yarn" }), /invalid --package-manager/);
        // Accepted values come from the runtime array, not the type union: dropping one
        // there breaks `--package-manager <value>` without failing typecheck.
        assert.equal(resolveConfig({ name: "x", packageManager: "bun" }).packageManager, "bun");
        assert.throws(() => resolveConfig({ name: "x", nodeExec: "swc" }), /invalid --node-exec/);
        // A value outside the documented list of resilience interceptors is refused, not skipped.
        assert.throws(() => resolveConfig({ name: "x", resilience: "retry,swc" }), /invalid --resilience "swc"/);
    });
});

describe("buildScripts", () => {
    it("bakes the lifecycle-fix into typecheck/test/start (not pnpm pre* hooks)", () => {
        const s = buildScripts(nodePnpm);
        assert.ok(s.typecheck.startsWith("buf generate &&"));
        assert.ok(s.test.startsWith("buf generate &&"));
        assert.ok(s.start.startsWith("buf generate &&"));
    });

    it("keeps build:proto package-manager-independent (no `pnpm run`)", () => {
        const s = buildScripts({ ...nodePnpm, packageManager: "npm" });
        assert.equal(s["build:proto"], "buf generate");
        assert.ok(!s["build:proto"].includes("pnpm"));
    });

    it("targets node with node --test by default", () => {
        assert.match(buildScripts(nodePnpm).test, /node --test/);
        assert.match(buildScripts(nodePnpm).start, /node src\/index\.ts/);
    });

    it("targets bun with bun test", () => {
        const s = buildScripts({ ...nodePnpm, runtime: "bun" });
        assert.match(s.test, /bun test/);
        assert.match(s.start, /bun src\/index\.ts/);
    });

    it("uses tsx under the node tsx model", () => {
        const s = buildScripts({ ...nodePnpm, nodeExec: "tsx" });
        assert.match(s.start, /tsx src\/index\.ts/);
        assert.match(s.test, /--import tsx/);
    });
});

describe("buildDevDeps", () => {
    const existing = {
        "@bufbuild/buf": "^1.65.0",
        "@bufbuild/protoc-gen-es": "^2.11.0",
        "@connectrpc/connect-node": "^2.1.1",
        "@types/node": "^25.2.0",
        tsx: "^4.21.0",
        typescript: "^5.9.3",
    };

    // The generated e2e test is in-process (no socket, so no network transport package) and uses
    // createLocalClient from @connectum/testing; everything else the base declared stays. The whole
    // object is compared, so a dependency dropped or added by accident fails as well.
    it("adds @connectum/testing, drops @connectrpc/connect-node and keeps the rest of the toolchain", () => {
        const higher = { ...existing, "@bufbuild/protoc-gen-es": "^2.99.0" };
        assert.deepEqual(buildDevDeps(higher, nodePnpm, "^1.0.0"), {
            "@bufbuild/buf": "^1.65.0",
            "@bufbuild/protoc-gen-es": "^2.99.0",
            "@connectum/testing": "^1.0.0",
            "@types/node": "^25.2.0",
            typescript: "^5.9.3",
        });
    });

    it("keeps tsx only under the node tsx model", () => {
        assert.equal(buildDevDeps(existing, nodePnpm, "^1.0.0").tsx, undefined);
        assert.equal(buildDevDeps(existing, { ...nodePnpm, nodeExec: "tsx" }, "^1.0.0").tsx, "^4.21.0");
        assert.equal(buildDevDeps(existing, { ...nodePnpm, runtime: "bun" }, "^1.0.0").tsx, undefined);
    });
});

describe("transformPackageJson", () => {
    const raw = JSON.stringify(
        {
            name: "@connectum/example-getting-started",
            private: true,
            type: "module",
            imports: { "#gen/*": "./gen/*", "#*": "./src/*" },
            scripts: { start: "node src/index.ts" },
            dependencies: { "@connectum/core": "^1.2.0", "@connectrpc/connect": "^2.1.1" },
            devDependencies: { "@bufbuild/buf": "^1.65.0", "@connectrpc/connect-node": "^2.1.1", typescript: "^5.9.3" },
            engines: { node: ">=25.2.0" },
        },
        null,
        2,
    );

    it("sets name, removes private, keeps imports and deps", () => {
        const pkg = JSON.parse(transformPackageJson(raw, nodePnpm));
        assert.equal(pkg.name, "payments");
        assert.equal(pkg.private, undefined);
        assert.deepEqual(pkg.imports, { "#gen/*": "./gen/*", "#*": "./src/*" });
        assert.equal(pkg.dependencies["@connectum/core"], "^1.2.0");
    });

    it("pins @connectum/testing to the same slice as @connectum/core", () => {
        const pkg = JSON.parse(transformPackageJson(raw, nodePnpm));
        assert.equal(pkg.devDependencies["@connectum/testing"], "^1.2.0");
    });

    it("raises protobuf-es from an older base (--ref) to the floor erasable enums need", () => {
        // The v1.3.0 base declares ^2.11.0 for both; erasable output imports `UnknownEnum`,
        // which @bufbuild/protobuf < 2.13.0 does not export.
        const older = JSON.stringify({
            name: "base",
            dependencies: { "@bufbuild/protobuf": "^2.11.0", "@connectum/core": "^1.0.0" },
            devDependencies: { "@bufbuild/protoc-gen-es": "^2.11.0", typescript: "^5.9.3" },
        });
        const pkg = JSON.parse(transformPackageJson(older, nodePnpm));
        assert.equal(pkg.dependencies["@bufbuild/protobuf"], "^2.16.0");
        assert.equal(pkg.devDependencies["@bufbuild/protoc-gen-es"], "^2.16.0");
        // The generator is never promoted into runtime dependencies, nor the runtime into dev.
        assert.equal(pkg.dependencies["@bufbuild/protoc-gen-es"], undefined);
        assert.equal(pkg.devDependencies["@bufbuild/protobuf"], undefined);
    });

    it("keeps a newer base's protobuf-es ranges", () => {
        const newer = JSON.stringify({
            name: "base",
            dependencies: { "@bufbuild/protobuf": "^2.17.0" },
            devDependencies: { "@bufbuild/protoc-gen-es": "^2.17.0" },
        });
        const pkg = JSON.parse(transformPackageJson(newer, nodePnpm));
        assert.equal(pkg.dependencies["@bufbuild/protobuf"], "^2.17.0");
        assert.equal(pkg.devDependencies["@bufbuild/protoc-gen-es"], "^2.17.0");
    });

    it("adds protobuf-es when the base declares neither (and has no dependencies block)", () => {
        const pkg = JSON.parse(transformPackageJson(JSON.stringify({ name: "base" }), nodePnpm));
        assert.deepEqual(pkg.dependencies, { "@bufbuild/protobuf": "^2.16.0" });
        assert.equal(pkg.devDependencies["@bufbuild/protoc-gen-es"], "^2.16.0");
    });

    it("keeps dependencies sorted after adding floored packages", () => {
        const pkg = JSON.parse(transformPackageJson(raw, nodePnpm));
        const keys = Object.keys(pkg.dependencies);
        assert.deepEqual(keys, [...keys].sort());
        assert.ok(keys.includes("@bufbuild/protobuf"));
    });

    it("sets the node engine floor per exec model", () => {
        assert.equal(JSON.parse(transformPackageJson(raw, nodePnpm)).engines.node, ">=25.2.0");
        assert.equal(JSON.parse(transformPackageJson(raw, { ...nodePnpm, nodeExec: "tsx" })).engines.node, ">=22.13.0");
    });
});

describe("generateGreeterE2eTest", () => {
    // Client method names follow from the sample proto (protobuf-es lowers the first letter of the
    // rpc name), the module name from the proto file name, and the factory signature from the
    // function @connectum/testing exports.
    const GREETER_METHODS = protoRpcMethods(GREETER_PROTO, "GreeterService").map((rpc) => rpc.charAt(0).toLowerCase() + rpc.slice(1));
    const authConfig: ScaffoldConfig = { ...nodePnpm, modules: { ...nodePnpm.modules, auth: true } };

    function e2e(config: ScaffoldConfig): ts.SourceFile {
        const sf = parseGenerated(generateGreeterE2eTest(config), "e2e.test.ts");
        assert.deepEqual(unresolvedWorkspaceImports(sf), []);
        return sf;
    }

    it("uses the in-process createLocalClient on the real server and the node:test runner on Node", () => {
        const sf = e2e(nodePnpm);
        const imports = importsOf(sf);
        assert.ok(imports.some((r) => r.from === "node:test" && r.names.includes("describe") && r.names.includes("it")));
        assert.ok(imports.some((r) => r.from === "@connectum/testing" && r.names.includes("createLocalClient")));
        assert.deepEqual(
            imports.filter((r) => r.from.startsWith("#gen/")),
            [{ from: "#gen/greeter/v1/greeter_pb.ts", names: ["GreeterService"], typeOnly: false }],
        );
        assert.equal(imports.some((r) => r.names.includes("createGrpcTransport")), false);
        const [create] = callsTo(sf, "createLocalClient");
        assert.deepEqual(argumentsOf(create as ts.CallExpression), ["server", "GreeterService"]);
        assert.equal(callsTo(sf, "createLocalClient").length, 1);
        // Every rpc of the sample service is exercised, awaited, through that client.
        const called = collectNodes(sf, ts.isAwaitExpression)
            .map((node) => node.expression)
            .filter(ts.isCallExpression)
            .map((call) => call.expression.getText())
            .filter((callee) => callee.startsWith("client."))
            .sort();
        assert.deepEqual(called, GREETER_METHODS.map((m) => `client.${m}`).sort());
    });

    it("exercises the real composition root, not a bare server", () => {
        // A test that builds its own `createServer({ services: [...] })` never runs the
        // interceptor chain, so a module that makes the service unreachable still passes.
        const sf = e2e(nodePnpm);
        assert.deepEqual(
            importsOf(sf).filter((r) => r.from === "#server.ts"),
            [{ from: "#server.ts", names: ["buildServer"], typeOnly: false }],
        );
        const [build] = callsTo(sf, "buildServer");
        assert.deepEqual(argumentsOf(build as ts.CallExpression), ["0"]);
        assert.equal(callsTo(sf, "buildServer").length, 1);
        assert.deepEqual(callsTo(sf, "createServer"), []);
        // The server handed to the client is the one that was built from the composition root.
        assert.equal((build as ts.CallExpression).parent.getText(), "server = buildServer(0)");
    });

    it("without auth expects each rpc to succeed", () => {
        const sf = e2e(nodePnpm);
        assert.deepEqual(callsTo(sf, "assert.rejects"), []);
        assert.deepEqual(
            callsTo(sf, "assert.equal").map((call) => argumentsOf(call)[0]),
            ["res.message", "res.message"],
        );
    });

    // Rejection by the auth chain surfaces as a ConnectError whose message carries the code name;
    // the substring the generated test waits for has to be what connect really puts there.
    it("asserts the auth chain both allows the public rpc and rejects the private one", () => {
        const sf = e2e(authConfig);
        const awaitedCalls = collectNodes(sf, ts.isAwaitExpression).map((node) => node.expression.getText());
        assert.ok(awaitedCalls.includes('client.sayHello({ name: "Ada" })'), awaitedCalls.join());
        const [rejects] = callsTo(sf, "assert.rejects");
        assert.ok(rejects !== undefined);
        assert.equal(callsTo(sf, "assert.rejects").length, 1);
        assert.equal(argumentsOf(rejects)[0], '() => client.sayGoodbye({ name: "Ada" })');
        const expectedText = /includes\("([^"]+)"\)/.exec(argumentsOf(rejects)[1] ?? "")?.[1];
        assert.equal(expectedText, "unauthenticated");
        assert.ok(new ConnectError("Missing credentials", Code.Unauthenticated).message.includes(expectedText as string));
        // The public rpc is not expected to be rejected.
        assert.equal(argumentsOf(rejects)[0]?.includes("sayHello"), false);
    });

    it("uses bun:test on Bun with the same body", () => {
        const sf = e2e({ ...nodePnpm, runtime: "bun" });
        assert.ok(importsOf(sf).some((r) => r.from === "bun:test" && r.names.includes("describe") && r.names.includes("it")));
        assert.equal(importsOf(sf).some((r) => r.from === "node:test"), false);
        assert.equal(callsTo(sf, "createLocalClient").length, 1);
        assert.equal(collectNodes(sf, ts.isAwaitExpression).length, collectNodes(e2e(nodePnpm), ts.isAwaitExpression).length);
    });
});

describe("transformBase", () => {
    const base = new Map<string, string>([
        [
            "package.json",
            JSON.stringify({ name: "@connectum/example-getting-started", private: true, dependencies: { "@connectum/core": "^1.0.0" }, devDependencies: { "@connectrpc/connect-node": "^2.1.1" } }, null, 2),
        ],
        ["pnpm-workspace.yaml", "packages: []\n"],
        ["tests/e2e/e2e.test.ts", "// old test using createGrpcTransport\n"],
        ["src/services/greeterService.ts", "export const greeterService = {};\n"],
        ["buf.gen.yaml", "version: v2\n"],
    ]);

    it("replaces the monorepo pnpm-workspace.yaml and regenerates the e2e test", () => {
        const out = transformBase(base, nodePnpm);
        // The monorepo workspace file ("packages: []") is replaced by a standalone one.
        assert.doesNotMatch(out.get("pnpm-workspace.yaml") ?? "", /packages:/);
        assert.match(out.get("tests/e2e/e2e.test.ts") ?? "", /createLocalClient/);
        assert.doesNotMatch(out.get("tests/e2e/e2e.test.ts") ?? "", /createGrpcTransport/);
    });

    it("preserves source files and generates a README", () => {
        const out = transformBase(base, nodePnpm);
        assert.equal(out.get("src/services/greeterService.ts"), "export const greeterService = {};\n");
        // buf.gen.yaml is regenerated (es-only when no catalog).
        assert.match(out.get("buf.gen.yaml") ?? "", /protoc-gen-es/);
        assert.doesNotMatch(out.get("buf.gen.yaml") ?? "", /catalog/);
        assert.match(out.get("README.md") ?? "", /payments/);
    });

    it("transforms package.json (name, no private, testing dep)", () => {
        const pkg = JSON.parse(transformBase(base, nodePnpm).get("package.json") ?? "{}");
        assert.equal(pkg.name, "payments");
        assert.equal(pkg.private, undefined);
        assert.equal(pkg.devDependencies["@connectum/testing"], "^1.0.0");
    });

    it("emits a standalone pnpm-workspace.yaml (build-approval) for pnpm only", () => {
        const pnpmOut = transformBase(base, nodePnpm);
        // pnpm 11 documents `allowBuilds` as a map of package matchers to true (allow) or false
        // (disallow) script execution, replaces onlyBuiltDependencies and friends with it, and
        // exits non-zero for any package left unlisted. So the file must be exactly such a map,
        // the build tool every project script starts with must be allowed, and a silently
        // dropped entry (protobufjs, pulled in by the otel module) is the regression to catch.
        const yaml = pnpmOut.get("pnpm-workspace.yaml") ?? "";
        const [header, ...entries] = yaml.trimEnd().split("\n");
        assert.equal(header, "allowBuilds:");
        const map = new Map(entries.map((line) => /^ {2}(?:'([^']+)'|([^':\s]+)): (true|false)$/.exec(line)).map((m) => [m?.[1] ?? m?.[2], m?.[3]] as const));
        assert.deepEqual([...map.keys()].sort(), ["@bufbuild/buf", "esbuild", "protobufjs"]);
        assert.equal(map.get("@bufbuild/buf"), "true");
        assert.equal(map.get("esbuild"), "true");
        assert.equal(map.get("protobufjs"), "false");
        assert.doesNotMatch(yaml, /onlyBuiltDependencies|neverBuiltDependencies|ignoredBuiltDependencies/);

        // Only pnpm exits non-zero on an unapproved build script — see transform.ts.
        for (const packageManager of ["npm", "bun"] as const) {
            const out = transformBase(base, { ...nodePnpm, packageManager });
            assert.equal(out.has("pnpm-workspace.yaml"), false, `${packageManager} must not get pnpm-workspace.yaml`);
        }
    });

    it("writes the same build-approval list whatever modules and runtime are selected", () => {
        // The list is deliberately static: every combination must get the entries for
        // everything any combination can install (otel brings protobufjs, tsx brings
        // esbuild), otherwise the combination that differs is the one whose install fails.
        const expected = transformBase(base, nodePnpm).get("pnpm-workspace.yaml");
        const variants: ScaffoldConfig[] = [
            { ...nodePnpm, modules: { otel: true } },
            { ...nodePnpm, nodeExec: "tsx", modules: { otel: true, catalog: true, resilience: ["retry", "timeout"] } },
            { ...nodePnpm, runtime: "bun", modules: { otel: true, events: { adapter: "kafka" } } },
        ];
        for (const config of variants) {
            assert.equal(transformBase(base, config).get("pnpm-workspace.yaml"), expected, JSON.stringify(config));
        }
    });

});
