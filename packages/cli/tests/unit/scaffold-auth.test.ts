/**
 * Unit tests for the auth module fragment (task 2.4): auth.ts generation, the
 * interceptor-ordering auth branch (D-3), the second buf module, and composition.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyAuthProtoAnnotations, generateAuthFile } from "../../src/scaffold/authFragment.ts";
import { generateBufYaml } from "../../src/scaffold/bufConfig.ts";
import { resolveConfig } from "../../src/scaffold/config.ts";
import { generateServer } from "../../src/scaffold/serverGen.ts";
import { transformBase } from "../../src/scaffold/transform.ts";
import type { ScaffoldConfig } from "../../src/scaffold/types.ts";

const authConfig: ScaffoldConfig = { name: "acct", runtime: "node", packageManager: "pnpm", nodeExec: "raw", sample: true, modules: { auth: true } };

describe("resolveConfig auth flag", () => {
    it("enables auth", () => {
        assert.equal(resolveConfig({ name: "x", auth: true }).modules.auth, true);
        assert.equal(resolveConfig({ name: "x" }).modules.auth, false);
    });
});

describe("generateAuthFile", () => {
    it("wires the JWT + proto-authz interceptors", () => {
        const f = generateAuthFile();
        assert.match(f, /import \{ createJwtAuthInterceptor \} from "@connectum\/auth"/);
        assert.match(f, /import \{ createProtoAuthzInterceptor, getPublicMethods \} from "@connectum\/auth\/proto"/);
        assert.match(f, /export function buildAuthInterceptors\(\): Interceptor\[\]/);
        assert.match(f, /getPublicMethods\(\[GreeterService\]\)/);
    });
});

describe("generateServer with auth (D-3 ordering)", () => {
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
    it("adds the node_modules auth module and RPC_* excepts", () => {
        const y = generateBufYaml(authConfig);
        assert.match(y, /- path: node_modules\/@connectum\/auth\/proto/);
        assert.match(y, /RPC_REQUEST_STANDARD_NAME/);
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
        assert.throws(() => applyAuthProtoAnnotations('syntax = "proto3";\n\npackage greeter.v1;\n'), /base example and the CLI have drifted/);
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
        assert.equal(pkg.dependencies["@connectum/auth"], "^1.2.0");
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
