/**
 * Unit tests for the auth module fragment: auth.ts generation, the
 * interceptor-ordering auth branch, the second buf module, and composition.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ts from "typescript";
import { applyAuthProtoAnnotations, generateAuthFile } from "../../src/scaffold/authFragment.ts";
import { generateBufYaml } from "../../src/scaffold/bufConfig.ts";
import { resolveConfig } from "../../src/scaffold/config.ts";
import { generateServer } from "../../src/scaffold/serverGen.ts";
import { transformBase } from "../../src/scaffold/transform.ts";
import type { ScaffoldConfig } from "../../src/scaffold/types.ts";
import { GREETER_PROTO } from "../helpers/baseFixture.ts";
import { runBuf } from "../helpers/bufProject.ts";
import { callsTo, collectNodes, exportedBindings, interfaceKeys, parseGenerated, propertiesOf, unresolvedWorkspaceImports } from "../helpers/generatedCode.ts";

const authConfig: ScaffoldConfig = { dir: "acct", name: "acct", runtime: "node", packageManager: "pnpm", nodeExec: "raw", sample: true, modules: { auth: true } };

describe("resolveConfig auth flag", () => {
    it("enables auth", () => {
        assert.equal(resolveConfig({ name: "x", auth: true }).modules.auth, true);
        assert.equal(resolveConfig({ name: "x" }).modules.auth, false);
    });
});

describe("generateAuthFile", () => {
    // The names are resolved against the sources of @connectum/auth, so a renamed or misspelled
    // factory, a stale option and a dropped call all fail, and a comment that only mentions
    // them does not count.
    it("authenticates with the JWT interceptor first and authorizes from the proto annotations second", () => {
        const sf = parseGenerated(generateAuthFile(), "auth.ts");
        assert.deepEqual(unresolvedWorkspaceImports(sf), []);
        assert.deepEqual(exportedBindings(sf), ["buildAuthInterceptors"]);

        const [jwt] = callsTo(sf, "createJwtAuthInterceptor");
        assert.ok(jwt !== undefined);
        assert.equal(callsTo(sf, "createJwtAuthInterceptor").length, 1);
        const jwtOptions = propertiesOf(jwt.arguments[0] as ts.Node);
        assert.deepEqual(
            jwtOptions.map((p) => p.name).filter((name) => !interfaceKeys("auth/src/types.ts", "JwtAuthInterceptorOptions").has(name)),
            [],
            "createJwtAuthInterceptor is given an option it does not have",
        );
        assert.equal(callsTo(sf, "createProtoAuthzInterceptor").length, 1);

        // The public methods are read from the proto annotations of the sample service and handed
        // to the JWT interceptor, which must not demand a token for them.
        const [publicMethods] = callsTo(sf, "getPublicMethods");
        assert.equal(publicMethods?.arguments.map((a) => a.getText()).join(), "[GreeterService]");
        const skipMethods = jwtOptions.find((p) => p.name === "skipMethods")?.value ?? "";
        assert.ok(skipMethods.includes("...publicMethods"), skipMethods);
        // The gRPC health and reflection protocols are reachable by probes and tooling without a token:
        // skipped by the JWT interceptor AND allowed by the authorizer (see the next test, and the
        // integration test that runs the generated chain on a real server).
        assert.ok(skipMethods.includes("...protocolMethods"), skipMethods);
        assert.deepEqual(protocolMethodsOf(sf), ["grpc.health.v1.Health/*", "grpc.reflection.v1.ServerReflection/*", "grpc.reflection.v1alpha.ServerReflection/*"]);

        // The chain is authentication, then authorization: the authorizer reads the identity the
        // JWT interceptor established.
        const [fn] = collectNodes(sf, ts.isFunctionDeclaration);
        const returned = collectNodes(fn as ts.Node, ts.isReturnStatement)[0]?.expression?.getText();
        assert.equal(returned, "[jwtAuth, authz]");
        const declared = Object.fromEntries(collectNodes(fn as ts.Node, ts.isVariableDeclaration).map((d) => [d.name.getText(), d.initializer?.getText().split("(")[0]]));
        assert.deepEqual(declared, { jwtAuth: "createJwtAuthInterceptor", authz: "createProtoAuthzInterceptor" });
    });
});

/** The string literals of `const protocolMethods = [...]`, or undefined when the module has no such constant. */
function protocolMethodsOf(sf: ts.SourceFile): string[] | undefined {
    const declaration = collectNodes(sf, ts.isVariableDeclaration).find((d) => d.name.getText() === "protocolMethods");
    const array = declaration?.initializer;
    return array !== undefined && ts.isArrayLiteralExpression(array) ? array.elements.filter(ts.isStringLiteral).map((e) => e.text) : undefined;
}

describe("generateAuthFile: the protocol endpoints", () => {
    // The authorizer is deny-by-default. A service named only in the JWT interceptor's `skipMethods`
    // gets past authentication, reaches the authorizer without an identity and is refused there with
    // `unauthenticated`: this was the state of the scaffolded chain for Health and reflection.
    it("gives the authorizer an unconditional allow rule for exactly the services the JWT interceptor skips", () => {
        const sf = parseGenerated(generateAuthFile({ healthcheck: true, reflection: true }), "auth.ts");
        const [authz] = callsTo(sf, "createProtoAuthzInterceptor");
        assert.ok(authz !== undefined);
        const options = propertiesOf(authz.arguments[0] as ts.Node);
        assert.deepEqual(
            options.map((p) => p.name).filter((name) => !interfaceKeys("auth/src/types.ts", "ProtoAuthzInterceptorOptions").has(name)),
            [],
            "createProtoAuthzInterceptor is given an option it does not have",
        );
        const rules = collectNodes(authz, ts.isArrayLiteralExpression)[0];
        assert.ok(rules !== undefined, authz.getText());
        const [rule] = collectNodes(rules, ts.isObjectLiteralExpression);
        const ruleProperties = propertiesOf(rule as ts.Node);
        assert.deepEqual(
            ruleProperties.map((p) => p.name).filter((name) => !interfaceKeys("auth/src/types.ts", "AuthzRule").has(name)),
            [],
            "the rule has a property AuthzRule does not have",
        );
        // No `requires`: an allow rule that demanded roles or scopes would again need an identity.
        assert.deepEqual(
            ruleProperties.map((p) => p.name),
            ["name", "methods", "effect"],
        );
        assert.equal(ruleProperties.find((p) => p.name === "methods")?.value, "protocolMethods");
        assert.equal(ruleProperties.find((p) => p.name === "effect")?.value, "AuthzEffect.ALLOW");
    });

    it("lists the health service only when the project mounts it, and the reflection services only when it mounts those", () => {
        const protocols = (modules: { healthcheck?: boolean; reflection?: boolean }): string[] | undefined => protocolMethodsOf(parseGenerated(generateAuthFile(modules), "auth.ts"));

        assert.deepEqual(protocols({ healthcheck: true, reflection: false }), ["grpc.health.v1.Health/*"]);
        assert.deepEqual(protocols({ healthcheck: false, reflection: true }), ["grpc.reflection.v1.ServerReflection/*", "grpc.reflection.v1alpha.ServerReflection/*"]);
        // Unset means mounted: both are on by default.
        assert.equal(protocols({})?.length, 3);
    });

    it("opens nothing, and imports nothing for it, when neither protocol is mounted", () => {
        const source = generateAuthFile({ healthcheck: false, reflection: false });
        const sf = parseGenerated(source, "auth.ts");

        assert.equal(protocolMethodsOf(sf), undefined);
        assert.doesNotMatch(source, /AuthzEffect|protocolMethods|grpc\.health|grpc\.reflection/);
        const [authz] = callsTo(sf, "createProtoAuthzInterceptor");
        assert.equal(authz?.arguments.length, 0);
        const [jwt] = callsTo(sf, "createJwtAuthInterceptor");
        assert.equal(propertiesOf(jwt?.arguments[0] as ts.Node).find((p) => p.name === "skipMethods")?.value, "[...publicMethods]");
    });

    it("resolves every name it imports against @connectum/auth, with the protocols both on and both off", () => {
        for (const modules of [{}, { healthcheck: false, reflection: false }]) {
            assert.deepEqual(unresolvedWorkspaceImports(parseGenerated(generateAuthFile(modules), "auth.ts")), [], JSON.stringify(modules));
        }
    });

    it("is what the transform writes for a project with the protocols switched off", () => {
        const out = transformBase(
            new Map<string, string>([
                ["package.json", JSON.stringify({ name: "b", dependencies: { "@connectum/core": "^1.2.0" }, devDependencies: {} })],
                ["proto/greeter/v1/greeter.proto", BASE_GREETER_PROTO],
            ]),
            { ...authConfig, modules: { auth: true, healthcheck: false, reflection: true } },
        );

        assert.deepEqual(protocolMethodsOf(parseGenerated(out.get("src/auth.ts") ?? "", "auth.ts")), ["grpc.reflection.v1.ServerReflection/*", "grpc.reflection.v1alpha.ServerReflection/*"]);
    });
});

describe("generateServer with auth: interceptor ordering", () => {
    it("places errorHandler then auth then default chain without a duplicate errorHandler", () => {
        const s = generateServer(authConfig);
        assert.match(s, /import \{ buildAuthInterceptors \} from "#auth\.ts"/);
        assert.match(s, /import \{ createDefaultInterceptors, createErrorHandlerInterceptor \} from "@connectum\/interceptors"/);
        assert.match(s, /\[createErrorHandlerInterceptor\(\), \.\.\.buildAuthInterceptors\(\), \.\.\.createDefaultInterceptors\(\{ errorHandler: false \}\)\]/);
    });

    it("keeps otel outermost when otel + auth are both enabled", () => {
        const s = generateServer({ ...authConfig, modules: { auth: true, otel: true } });
        const arr = s.slice(s.indexOf("interceptors: ["));
        assert.ok(arr.indexOf("createOtelInterceptor") < arr.indexOf("createErrorHandlerInterceptor"));
        assert.ok(arr.indexOf("createErrorHandlerInterceptor") < arr.indexOf("buildAuthInterceptors"));
    });
});

describe("generateBufYaml with auth", () => {
    const authProject = (yaml: string): Map<string, string> =>
        new Map([
            ["buf.yaml", yaml],
            ["proto/greeter/v1/greeter.proto", applyAuthProtoAnnotations(GREETER_PROTO)],
        ]);

    // The judge is buf itself, run over the scaffolded layout: the auth option proto lives in a
    // second module under node_modules, and the annotated sample proto imports it.
    it("declares the node_modules auth module so buf resolves the annotated sample proto against it", () => {
        const yaml = generateBufYaml(authConfig);
        const accepted = runBuf(["build", "-o", "-#format=json"], authProject(yaml), { withAuthModule: true });
        assert.equal(accepted.status, 0, accepted.output);
        const greeter = (JSON.parse(accepted.output) as { file: Array<{ name: string; dependency?: string[] }> }).file.find((file) => file.name === "greeter/v1/greeter.proto");
        assert.deepEqual(greeter?.dependency, ["connectum/auth/v1/options.proto"]);

        // Without the module declaration the import cannot be resolved.
        const rejected = runBuf(["build"], authProject(yaml.replace("  - path: node_modules/@connectum/auth/proto\n", "")), { withAuthModule: true });
        assert.notEqual(rejected.status, 0);
    });

    it("lets buf lint accept the scaffolded auth project", () => {
        const accepted = runBuf(["lint"], authProject(generateBufYaml(authConfig)), { withAuthModule: true });
        assert.equal(accepted.status, 0, accepted.output);
    });

    // Every rule the generator switches off has to be one the project would otherwise break.
    // buf lint accepts the scaffolded auth project (sample service, auth option proto) without
    // any exception, so an except added for auth would silence a rule that nothing in the
    // project violates, and would also switch it off for every service the user adds.
    it("excepts no lint rule that the scaffolded auth project does not break", () => {
        const yaml = generateBufYaml(authConfig);
        assert.doesNotMatch(yaml, /except|RPC_|SERVICE_SUFFIX/, yaml);
        // With no except at all the project is judged by the full STANDARD set, and buf accepts it.
        const accepted = runBuf(["lint"], authProject(yaml), { withAuthModule: true });
        assert.equal(accepted.status, 0, accepted.output);
    });

    it("keeps the event-handler excepts when auth is combined with events, because of the events", () => {
        const yaml = generateBufYaml({ ...authConfig, modules: { auth: true, events: { adapter: "nats" } } });
        const excepts = [...yaml.matchAll(/^ {4}- ((?:RPC|SERVICE)_[A-Z_]+)$/gm)].map((m) => m[1]);
        assert.deepEqual(excepts, ["SERVICE_SUFFIX", "RPC_REQUEST_STANDARD_NAME", "RPC_RESPONSE_STANDARD_NAME", "RPC_REQUEST_RESPONSE_UNIQUE"]);
    });
    it("has no auth module when auth is disabled", () => {
        assert.doesNotMatch(generateBufYaml({ ...authConfig, modules: {} }), /node_modules/);
    });
});

/** The shape of the base sample proto that the auth annotation transform depends on. */
const BASE_GREETER_PROTO = `syntax = "proto3";

package greeter.v1;

service GreeterService {
  rpc SayHello(SayHelloRequest) returns (SayHelloResponse) {}

  rpc SayGoodbye(SayGoodbyeRequest) returns (SayGoodbyeResponse) {}
}
`;

describe("applyAuthProtoAnnotations", () => {
    it("marks SayHello public and leaves SayGoodbye authenticated", () => {
        // proto-authz is deny-by-default: without this annotation a scaffolded --auth
        // project rejects its own sample call with "[unauthenticated] Missing credentials"
        // (verified against a live scaffold).
        const out = applyAuthProtoAnnotations(BASE_GREETER_PROTO);
        assert.match(out, /rpc SayHello\(SayHelloRequest\) returns \(SayHelloResponse\) \{\n\s+option \(connectum\.auth\.v1\.method_auth\) = \{ public: true \};\n\s+\}/);
        assert.match(out, /rpc SayGoodbye\(SayGoodbyeRequest\) returns \(SayGoodbyeResponse\) \{\}/);
    });

    it("imports the auth option proto after the package declaration", () => {
        const out = applyAuthProtoAnnotations(BASE_GREETER_PROTO);
        assert.match(out, /package greeter\.v1;\n\nimport "connectum\/auth\/v1\/options\.proto";/);
    });

    it("fails loudly if the base drifted and SayHello is gone", () => {
        // Emitting a project whose sample call cannot succeed is worse than refusing.
        assert.throws(() => applyAuthProtoAnnotations('syntax = "proto3";\n\npackage greeter.v1;\n'), /rpc SayHello.*drifted/s);
    });

    it("fails loudly if the package declaration is gone", () => {
        assert.throws(() => applyAuthProtoAnnotations(`syntax = "proto3";\n\nservice GreeterService {\n  ${"rpc SayHello(SayHelloRequest) returns (SayHelloResponse) {}"}\n}\n`), /`package` declaration.*drifted/s);
    });

    it("preserves the rest of the file verbatim", () => {
        // A line scan must not reflow or drop anything it was not asked to touch.
        const out = applyAuthProtoAnnotations(BASE_GREETER_PROTO);
        assert.ok(out.includes('syntax = "proto3";'));
        assert.ok(out.includes("service GreeterService {"));
        assert.equal(out.split("\n").filter((l) => l.includes("rpc SayHello")).length, 1);
    });
});

describe("transformBase with auth", () => {
    const base = new Map<string, string>([
        ["package.json", JSON.stringify({ name: "@connectum/example-getting-started", dependencies: { "@connectum/core": "^1.2.0" }, devDependencies: {} })],
        ["buf.yaml", "version: v2\n"],
        ["src/services/greeterService.ts", "export const greeterService = {};\n"],
        ["proto/greeter/v1/greeter.proto", BASE_GREETER_PROTO],
    ]);

    it("emits src/auth.ts and adds @connectum/auth, buf module", () => {
        const out = transformBase(base, authConfig);
        assert.ok(out.has("src/auth.ts"));
        const pkg = JSON.parse(out.get("package.json") ?? "{}");
        // ^1.2.0 in the base is below the release that exports the auth option
        // descriptors the generated code imports, so the slice moves to ^1.3.0.
        assert.equal(pkg.dependencies["@connectum/auth"], "^1.3.0");
        assert.equal(pkg.dependencies["@connectum/core"], "^1.3.0");
        assert.match(out.get("buf.yaml") ?? "", /node_modules\/@connectum\/auth\/proto/);
    });

    it("annotates the sample proto so the scaffolded project is reachable", () => {
        const out = transformBase(base, authConfig);
        assert.match(out.get("proto/greeter/v1/greeter.proto") ?? "", /method_auth\) = \{ public: true \}/);
    });

    it("leaves the sample proto untouched when auth is off", () => {
        const out = transformBase(base, { ...authConfig, modules: {} });
        assert.equal(out.get("proto/greeter/v1/greeter.proto"), BASE_GREETER_PROTO);
    });
});
