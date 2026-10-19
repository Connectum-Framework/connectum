/**
 * Unit tests for the composition-root generator (server.ts / index.ts) and the
 * otel module fragment — most importantly the interceptor-ordering policy.
 *
 * The generated modules are parsed, and the names they use are resolved against the sources of
 * the workspace packages that export them (the options `createServer` accepts, the flags
 * `createDefaultInterceptors` knows, the exports of `@connectum/*`), so a comment that merely
 * mentions a call, a misspelled option or a dropped flag cannot satisfy a check.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ts from "typescript";
import { generateIndex, generateServer } from "../../src/scaffold/serverGen.ts";
import { transformPackageJson } from "../../src/scaffold/transform.ts";
import type { ScaffoldConfig } from "../../src/scaffold/types.ts";
import {
    callsTo,
    createServerOptions,
    elementsOf,
    interfaceKeys,
    parseGenerated,
    propertiesOf,
    propertyValue,
    unresolvedWorkspaceImports,
} from "../helpers/generatedCode.ts";

/** Options the real `createServer`, `createDefaultInterceptors`, `createOtelInterceptor` and `initProvider` accept. */
const CREATE_SERVER_OPTIONS = interfaceKeys("core/src/types.ts", "CreateServerOptions");
const DEFAULT_INTERCEPTOR_OPTIONS = interfaceKeys("interceptors/src/defaults.ts", "DefaultInterceptorOptions");
const OTEL_INTERCEPTOR_OPTIONS = interfaceKeys("otel/src/types.ts", "OtelInterceptorOptions");
const PROVIDER_OPTIONS = interfaceKeys("otel/src/provider.ts", "ProviderOptions");
const HEALTHCHECK_OPTIONS = interfaceKeys("healthcheck/src/types.ts", "HealthcheckOptions");

function serverOf(config: ScaffoldConfig): { sf: ts.SourceFile; options: ts.ObjectLiteralExpression } {
    const sf = parseGenerated(generateServer(config), "server.ts");
    assert.deepEqual(unresolvedWorkspaceImports(sf), []);
    const options = createServerOptions(sf);
    const unknown = propertiesOf(options)
        .map((p) => p.name)
        .filter((name) => !CREATE_SERVER_OPTIONS.has(name));
    assert.deepEqual(unknown, [], "createServer is given an option it does not have");
    return { sf, options };
}

/** The `createDefaultInterceptors({...})` flags of an interceptor expression, as name -> initializer text. */
function defaultInterceptorFlags(expression: string): Record<string, string> {
    const call = callsTo(parseGenerated(`const x = ${expression.replace(/^\.\.\./, "")};`), "createDefaultInterceptors")[0];
    assert.ok(call !== undefined, expression);
    const [argument] = call.arguments;
    if (argument === undefined) {
        return {};
    }
    const flags = Object.fromEntries(propertiesOf(argument).map((p) => [p.name, p.value]));
    assert.deepEqual(
        Object.keys(flags).filter((name) => !DEFAULT_INTERCEPTOR_OPTIONS.has(name)),
        [],
        "createDefaultInterceptors is given a flag it does not have",
    );
    return flags;
}

const base: ScaffoldConfig = { dir: "payments", name: "payments", runtime: "node", packageManager: "pnpm", nodeExec: "raw", sample: true, modules: {} };
const withOtel: ScaffoldConfig = { ...base, modules: { otel: true } };

describe("generateServer", () => {
    it("base hosts the greeter with the default chain, health and reflection, as calls and not as comments", () => {
        const { sf, options } = serverOf(base);
        assert.equal(propertyValue(options, "services")?.getText(), "[greeterService]");
        assert.equal(propertyValue(options, "interceptors")?.getText(), "createDefaultInterceptors()");
        assert.deepEqual(elementsOf(propertyValue(options, "protocols")), ["Healthcheck({ httpEnabled: true })", "Reflection()"]);
        // Healthcheck is given an option the real Healthcheck() has.
        assert.ok(HEALTHCHECK_OPTIONS.has("httpEnabled"));
        assert.equal(callsTo(sf, "Reflection").length, 1);
        assert.equal(callsTo(sf, "Healthcheck").length, 1);
        assert.equal(callsTo(sf, "createDefaultInterceptors").length, 1);
        assert.equal(callsTo(sf, "createOtelInterceptor").length, 0);
    });

    it("otel is outermost in the interceptor chain", () => {
        const { sf, options } = serverOf(withOtel);
        // trustRemote stays false (the framework default): the scaffolded server binds
        // 0.0.0.0, so inheriting a caller's trace context and sampling decision must be
        // an explicit deployment choice, never a generator default.
        assert.deepEqual(elementsOf(propertyValue(options, "interceptors")), ["createOtelInterceptor({ trustRemote: false })", "...createDefaultInterceptors()"]);
        assert.ok(OTEL_INTERCEPTOR_OPTIONS.has("trustRemote"));
        assert.equal(callsTo(sf, "createOtelInterceptor").length, 1);
    });
});

describe("resilience + protocol toggles", () => {
    it("injects exactly the selected opt-in resilience flags, each enabled, into createDefaultInterceptors", () => {
        const { options } = serverOf({ ...base, modules: { resilience: ["retry", "timeout"] } });
        const flags = defaultInterceptorFlags(propertyValue(options, "interceptors")?.getText() ?? "");
        assert.deepEqual(flags, { retry: "true", timeout: "true" });
    });

    // Every value the --resilience flag accepts has to name a flag createDefaultInterceptors has;
    // a value mapped to a misspelled flag would enable nothing and report no error.
    it("maps every documented --resilience value to a flag createDefaultInterceptors has", () => {
        const documented = ["timeout", "bulkhead", "circuitBreaker", "retry"] as const;
        const { options } = serverOf({ ...base, modules: { resilience: [...documented] } });
        const flags = defaultInterceptorFlags(propertyValue(options, "interceptors")?.getText() ?? "");
        assert.deepEqual(Object.keys(flags).sort(), [...documented].sort());
    });

    it("keeps every resilience flag when merged with the auth errorHandler:false branch", () => {
        const { options } = serverOf({ ...base, modules: { auth: true, resilience: ["retry", "bulkhead"] } });
        const chain = elementsOf(propertyValue(options, "interceptors"));
        assert.deepEqual(chain.slice(0, 2), ["createErrorHandlerInterceptor()", "...buildAuthInterceptors()"]);
        assert.equal(chain.length, 3);
        assert.deepEqual(defaultInterceptorFlags(chain[2] as string), { errorHandler: "false", retry: "true", bulkhead: "true" });
    });

    it("omits Healthcheck / Reflection when toggled off", () => {
        const { sf, options } = serverOf({ ...base, modules: { healthcheck: false, reflection: false } });
        assert.deepEqual(elementsOf(propertyValue(options, "protocols")), []);
        assert.equal(callsTo(sf, "Healthcheck").length, 0);
        assert.equal(callsTo(sf, "Reflection").length, 0);
    });

    it("keeps both protocols by default", () => {
        const { options } = serverOf(base);
        assert.deepEqual(elementsOf(propertyValue(options, "protocols")), ["Healthcheck({ httpEnabled: true })", "Reflection()"]);
    });

    it("index.ts drops healthcheckManager when healthcheck is off", () => {
        const i = generateIndex({ ...base, modules: { healthcheck: false } });
        assert.doesNotMatch(i, /healthcheckManager/);
    });
});

describe("generateIndex", () => {
    it("base has no provider lifecycle", () => {
        const i = generateIndex(base);
        assert.doesNotMatch(i, /initProvider/);
        assert.doesNotMatch(i, /shutdownProvider/);
    });

    it("otel initializes the provider at startup and shuts it down in the stop handler", () => {
        const sf = parseGenerated(generateIndex(withOtel), "index.ts");
        assert.deepEqual(unresolvedWorkspaceImports(sf), []);

        const [init] = callsTo(sf, "initProvider");
        assert.ok(init !== undefined);
        assert.equal(callsTo(sf, "initProvider").length, 1);
        // The provider is started by the module itself, not inside a handler that may never run.
        assert.ok(ts.isExpressionStatement(init.parent) && init.parent.parent === sf, "initProvider is not a top-level statement");
        const [initOptions] = init.arguments;
        assert.deepEqual(propertiesOf(initOptions as ts.Node), [{ name: "serviceName", value: '"payments"' }]);
        assert.ok(PROVIDER_OPTIONS.has("serviceName"));

        // Shutting down has to be awaited inside the handler that runs when the server stops,
        // otherwise buffered telemetry is lost on exit.
        const stopHandlers = callsTo(sf, "server.on").filter((call) => call.arguments[0]?.getText() === '"stop"');
        assert.equal(stopHandlers.length, 1);
        const handler = stopHandlers[0]?.arguments[1];
        assert.ok(handler !== undefined);
        const shutdowns = callsTo(handler, "shutdownProvider");
        assert.equal(shutdowns.length, 1);
        assert.ok(ts.isAwaitExpression(shutdowns[0]?.parent as ts.Node), "shutdownProvider is not awaited");
        assert.equal(callsTo(sf, "shutdownProvider").length, 1);
    });
});

describe("transformPackageJson (otel module)", () => {
    const raw = JSON.stringify({
        name: "@connectum/example-getting-started",
        dependencies: { "@connectum/core": "^1.2.0", "@connectrpc/connect": "^2.1.1" },
    });

    it("adds @connectum/otel on the same slice when otel is enabled", () => {
        const pkg = JSON.parse(transformPackageJson(raw, withOtel));
        assert.equal(pkg.dependencies["@connectum/otel"], "^1.2.0");
    });

    it("does not add @connectum/otel when disabled", () => {
        const pkg = JSON.parse(transformPackageJson(raw, base));
        assert.equal(pkg.dependencies["@connectum/otel"], undefined);
    });
});

describe("generateIndex: project name in the startup log", () => {
    const logStatement = (source: string): string => {
        const line = source.split("\n").find((l) => l.includes("ready on"));
        assert.ok(line, "startup log statement not found");
        return line.trim();
    };

    // The statement is executed as generated: if the name were spliced into a template
    // literal unescaped, `${…}` would run and the printed text would differ.
    const hostileNames = ["a${globalThis.__connectumInjected = 1}b", "a`b", 'a"b', "a'b", "a\\b", "a\\${x}b", "a\nb"];

    for (const name of hostileNames) {
        it(`prints ${JSON.stringify(name)} literally and runs nothing`, () => {
            const statement = logStatement(generateIndex({ ...base, name }));
            const printed: string[] = [];
            const run = new Function("console", "addr", statement);
            run({ log: (text: string) => printed.push(text) }, { address: "127.0.0.1", port: 5000 });
            assert.deepEqual(printed, [`${name} ready on 127.0.0.1:5000`]);
            assert.equal((globalThis as { __connectumInjected?: number }).__connectumInjected, undefined);
        });
    }
});
