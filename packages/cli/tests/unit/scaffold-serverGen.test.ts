/**
 * Unit tests for the composition-root generator (server.ts / index.ts) and the
 * otel module fragment — most importantly the interceptor-ordering policy (D-3).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { generateIndex, generateServer } from "../../src/scaffold/serverGen.ts";
import { transformPackageJson } from "../../src/scaffold/transform.ts";
import type { ScaffoldConfig } from "../../src/scaffold/types.ts";

const base: ScaffoldConfig = { name: "payments", runtime: "node", packageManager: "pnpm", nodeExec: "raw", sample: true, modules: {} };
const withOtel: ScaffoldConfig = { ...base, modules: { otel: true } };

describe("generateServer", () => {
    it("base uses createDefaultInterceptors() and wires health/reflection/greeter", () => {
        const s = generateServer(base);
        assert.match(s, /interceptors: createDefaultInterceptors\(\)/);
        assert.match(s, /Healthcheck\(\{ httpEnabled: true \}\)/);
        assert.match(s, /Reflection\(\)/);
        assert.match(s, /services: \[greeterService\]/);
        assert.doesNotMatch(s, /createOtelInterceptor/);
    });

    it("otel is outermost in the interceptor chain (D-3)", () => {
        const s = generateServer(withOtel);
        assert.match(s, /import \{ createOtelInterceptor \} from "@connectum\/otel"/);
        assert.match(s, /interceptors: \[createOtelInterceptor\(\{ trustRemote: true \}\), \.\.\.createDefaultInterceptors\(\)\]/);
        // otel must appear before createDefaultInterceptors in the array (outermost).
        const arr = s.slice(s.indexOf("interceptors: ["));
        assert.ok(arr.indexOf("createOtelInterceptor") < arr.indexOf("createDefaultInterceptors"));
    });
});

describe("generateIndex", () => {
    it("base has no provider lifecycle", () => {
        const i = generateIndex(base);
        assert.doesNotMatch(i, /initProvider/);
        assert.doesNotMatch(i, /shutdownProvider/);
    });

    it("otel initializes and shuts down the provider", () => {
        const i = generateIndex(withOtel);
        assert.match(i, /import \{ initProvider, shutdownProvider \} from "@connectum\/otel"/);
        assert.match(i, /initProvider\(\{ serviceName: "payments" \}\)/);
        assert.match(i, /await shutdownProvider\(\)/);
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
