/**
 * `--no-sample`: a config-only project. The generated tree must contain no trace of the
 * Greeter sample, the server must start with an empty service list, and a smoke test must
 * build the real server so the project's own test command has something to prove.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveConfig } from "../../src/scaffold/config.ts";
import { generateServer } from "../../src/scaffold/serverGen.ts";
import { generateReadme, transformBase } from "../../src/scaffold/transform.ts";
import type { ScaffoldConfig } from "../../src/scaffold/types.ts";
import { baseFiles } from "../helpers/baseFixture.ts";

const configOnly: ScaffoldConfig = { dir: "svc", name: "svc", runtime: "node", packageManager: "pnpm", nodeExec: "raw", sample: false, modules: {} };

describe("resolveConfig: --no-sample", () => {
    it("is carried into the config", () => {
        assert.equal(resolveConfig({ name: "svc", sample: false }).sample, false);
        assert.equal(resolveConfig({ name: "svc" }).sample, true);
    });

    it("is refused together with --auth or --events, naming both options", () => {
        assert.throws(() => resolveConfig({ name: "svc", sample: false, auth: true }), /--no-sample cannot be combined with --auth/);
        assert.throws(() => resolveConfig({ name: "svc", sample: false, events: "nats" }), /--no-sample cannot be combined with --events/);
    });

    it("still allows the modules that do not need the sample service", () => {
        const cfg = resolveConfig({ name: "svc", sample: false, otel: true, resilience: "retry" });
        assert.equal(cfg.modules.otel, true);
    });
});

describe("transformBase: --no-sample", () => {
    const out = transformBase(baseFiles(), configOnly);

    it("emits no Greeter proto, service source or Greeter end-to-end test", () => {
        assert.deepEqual([...out.keys()].filter((p) => p.startsWith("proto/greeter/")), []);
        assert.equal(out.has("src/services/greeterService.ts"), false);
        assert.equal(out.has("tests/e2e/e2e.test.ts"), false);
    });

    it("mentions Greeter in no generated file", () => {
        const offenders = [...out].filter(([, content]) => /greeter/i.test(content)).map(([path]) => path);
        assert.deepEqual(offenders, []);
    });

    it("emits a smoke test that builds the real server and checks it is only created", () => {
        const smoke = out.get("tests/e2e/server.test.ts") ?? "";
        assert.match(smoke, /from "node:test"/);
        assert.match(smoke, /buildServer\(0\)/);
        assert.match(smoke, /server\.state, "created"/);
    });

    it("uses bun:test for the smoke test on Bun", () => {
        const bun = transformBase(baseFiles(), { ...configOnly, runtime: "bun" });
        assert.match(bun.get("tests/e2e/server.test.ts") ?? "", /from "bun:test"/);
    });

    it("keeps the package manifest and the other base files", () => {
        assert.ok(out.has("package.json"));
        assert.ok(out.has("tsconfig.json"));
        assert.ok(out.has("src/server.ts"));
    });

    it("leaves the default scaffold unchanged: sample files stay, no smoke test", () => {
        const withSample = transformBase(baseFiles(), { ...configOnly, sample: true });
        assert.ok(withSample.has("proto/greeter/v1/greeter.proto"));
        assert.ok(withSample.has("src/services/greeterService.ts"));
        assert.match(withSample.get("tests/e2e/e2e.test.ts") ?? "", /GreeterService/);
        assert.equal(withSample.has("tests/e2e/server.test.ts"), false);
    });
});

describe("generateServer / generateReadme: --no-sample", () => {
    it("starts with an empty service list and imports no sample service", () => {
        const s = generateServer(configOnly);
        assert.match(s, /services: \[\],/);
        assert.doesNotMatch(s, /greeter/i);
    });

    it("keeps the interceptors and protocols of the other modules", () => {
        const s = generateServer({ ...configOnly, modules: { otel: true, resilience: ["retry"] } });
        assert.match(s, /createOtelInterceptor/);
        assert.match(s, /retry: true/);
        assert.match(s, /Healthcheck/);
    });

    it("names `generate service` as the first step and never the sample", () => {
        const readme = generateReadme(configOnly);
        assert.match(readme, /connectum generate service <name>/);
        assert.doesNotMatch(readme, /Greeter/);
        const start = readme.indexOf("## Getting started");
        assert.ok(readme.indexOf("generate service <name>", start) < readme.indexOf("run start", start));
    });
});
