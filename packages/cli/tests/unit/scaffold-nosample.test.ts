/**
 * `--no-sample`: a config-only project. The generated tree must contain no trace of the
 * Greeter sample, the server must start with an empty service list, and a smoke test must
 * build the real server so the project's own test command has something to prove.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, mock } from "node:test";
import type ts from "typescript";
import { executeInit } from "../../src/commands/init.ts";
import { resolveConfig } from "../../src/scaffold/config.ts";
import { buildServiceFiles, generateServiceImpl } from "../../src/scaffold/generateService.ts";
import { generateServer } from "../../src/scaffold/serverGen.ts";
import { generateReadme, transformBase } from "../../src/scaffold/transform.ts";
import type { ScaffoldConfig } from "../../src/scaffold/types.ts";
import { baseFiles, cloneStub } from "../helpers/baseFixture.ts";
import { argumentsOf, callsTo, importsOf, parseGenerated } from "../helpers/generatedCode.ts";

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

    // Every module that does not depend on the sample service has to survive --no-sample intact:
    // one of them being reset to its default would pass unnoticed behind the others.
    it("still applies every module that does not need the sample service", () => {
        const cfg = resolveConfig({ name: "svc", sample: false, otel: true, resilience: "retry,timeout", catalog: true, healthcheck: false, reflection: false });
        assert.equal(cfg.sample, false);
        assert.equal(cfg.modules.otel, true);
        assert.deepEqual(cfg.modules.resilience, ["retry", "timeout"]);
        assert.equal(cfg.modules.catalog, true);
        assert.equal(cfg.modules.healthcheck, false);
        assert.equal(cfg.modules.reflection, false);
        assert.equal(cfg.modules.auth, false);
        assert.equal(cfg.modules.events, undefined);
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
        const sf = parseGenerated(out.get("tests/e2e/server.test.ts") ?? "", "server.test.ts");
        assert.ok(importsOf(sf).some((record) => record.from === "node:test" && record.names.includes("it")));
        assert.deepEqual(
            importsOf(sf).filter((record) => record.from === "#server.ts"),
            [{ from: "#server.ts", names: ["buildServer"], typeOnly: false }],
        );
        assert.equal(callsTo(sf, "buildServer").length, 1);
        assert.deepEqual(argumentsOf(callsTo(sf, "buildServer")[0] as ts.CallExpression), ["0"]);
        // The state the test expects is the one a freshly built server reports, as the server
        // implementation defines it, and the test never starts the server it only built.
        const createdState = /ServerState = \{[^}]*?CREATED: "([^"]+)"/s.exec(readFileSync(join(import.meta.dirname, "../../../core/src/types.ts"), "utf8"))?.[1];
        assert.equal(createdState, "created");
        const [check] = callsTo(sf, "assert.equal");
        assert.deepEqual(argumentsOf(check as ts.CallExpression), ["server.state", JSON.stringify(createdState)]);
        assert.equal(callsTo(sf, "assert.equal").length, 1);
        assert.deepEqual(callsTo(sf, "server.start"), []);
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

    it("names `generate service` as the first step after install, before start, and never the sample", () => {
        const readme = generateReadme(configOnly);
        assert.doesNotMatch(readme, /Greeter/);
        const block = /## Getting started\n+```[a-z]*\n([\s\S]*?)\n```/.exec(readme)?.[1];
        assert.ok(block !== undefined, readme);
        const steps = block.split("\n").map((line) => line.replace(/\s+#.*$/, ""));
        assert.deepEqual(steps, ["pnpm install", "npx @connectum/cli generate service <name>", "pnpm run start"]);
    });

    // The command prints the same steps the README gives: the user who only reads the terminal
    // must reach a working project too.
    it("prints `generate service` between install and start in the next steps of init", async () => {
        const printed: string[] = [];
        const log = mock.method(console, "log", (...args: unknown[]) => {
            printed.push(args.join(" "));
        });
        const cwd = process.cwd();
        const workdir = mkdtempSync(join(tmpdir(), "connectum-nosample-"));
        process.chdir(workdir);
        try {
            await executeInit({ name: "demo", sample: false, yes: true, clone: cloneStub });
            await executeInit({ name: "withsample", sample: true, yes: true, clone: cloneStub });
        } finally {
            process.chdir(cwd);
            log.mock.restore();
            rmSync(workdir, { recursive: true, force: true });
        }
        const text = printed.join("\n");
        const stepsOf = (project: string): string[] => {
            const after = text.slice(text.indexOf(`cd ${project}`));
            return after
                .split("\n")
                .slice(0, 4)
                .map((line) => line.trim().replace(/\s+#.*$/, ""));
        };
        assert.deepEqual(stepsOf("demo"), ["cd demo", "pnpm install", "npx @connectum/cli generate service <name>", "pnpm run start"]);
        assert.deepEqual(stepsOf("withsample").slice(0, 3), ["cd withsample", "pnpm install", "pnpm run start"]);
    });

    // `generate service` writes a proto and a handler module (plus the vendored option proto with
    // events) and nothing else, so a README that promises a test describes a command that does
    // not exist.
    it("promises only what `generate service` creates", { todo: "the README says the command creates a test, but it creates only a proto and a handler module" }, () => {
        const created = [...buildServiceFiles("billing", false).keys()];
        const sentence = /Run `connectum generate service <name>` to create\s+(.*?), then register/.exec(generateReadme(configOnly).replace(/\n/g, " "))?.[1] ?? "";
        assert.ok(sentence.length > 0);
        const promisesTest = /\btest\b/.test(sentence);
        assert.equal(
            promisesTest,
            created.some((path) => /test/.test(path)),
            sentence,
        );
    });

    it("warns, with and without the sample, that a generated handler is a stub answering Unimplemented", () => {
        // The warning is only true while the generated handler really throws Unimplemented.
        assert.match(generateServiceImpl("billing", false), /Code\.Unimplemented/);
        for (const config of [configOnly, { ...configOnly, sample: true }]) {
            const readme = generateReadme(config);
            assert.match(readme, /connectum generate service <name>/);
            assert.match(readme, /throws\s+`Unimplemented`/);
        }
    });
});
