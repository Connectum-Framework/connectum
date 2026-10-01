/**
 * Unit tests for importing Connectum's option descriptors from the packages.
 *
 * With auth or events, a scaffolded project must not generate its own copy of
 * `connectum/{auth,events}/v1/options_pb.ts`: `buf.gen.yaml` maps those imports to
 * `@connectum/{auth,events}/gen/...` and keeps the option protos out of generation, and
 * `package.json` must require a Connectum release that exports those subpaths. Each test
 * names the defect it catches when that is not obvious from the assertion.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { generateBufGenYaml, optionProtoImports } from "../../src/scaffold/bufConfig.ts";
import { EVENTS_OPTIONS_PROTO_PATH, generateEventsOptionsProto } from "../../src/scaffold/eventsFragment.ts";
import { buildServiceFiles, generateServiceProto } from "../../src/scaffold/generateService.ts";
import { transformBase } from "../../src/scaffold/transform.ts";
import type { ModuleSelection, ScaffoldConfig } from "../../src/scaffold/types.ts";
import {
    alignConnectumSlice,
    CONNECTUM_SLICE_FLOOR,
    connectumSliceFloorApplies,
    connectumSliceRange,
    connectumSliceViolations,
} from "../../src/scaffold/versionFloors.ts";

const config = (modules: ModuleSelection): ScaffoldConfig => ({ name: "svc", runtime: "node", packageManager: "npm", nodeExec: "raw", sample: true, modules });

const AUTH: ModuleSelection = { auth: true };
const EVENTS: ModuleSelection = { events: { adapter: "nats" } };
const ALL: ModuleSelection = { auth: true, events: { adapter: "nats" }, catalog: true };

/** One chunk per `- local:` plugin entry, keyed by the plugin name. */
const pluginBlocks = (yaml: string): Map<string, string> =>
    new Map(
        yaml
            .split("  - local: ")
            .slice(1)
            .map((block) => [block.slice(0, block.indexOf("\n")), block]),
    );

/** The `inputs:` block (up to `plugins:`), or "" when there is none. */
const inputsBlock = (yaml: string): string => {
    const start = yaml.indexOf("inputs:");
    return start === -1 ? "" : yaml.slice(start, yaml.indexOf("plugins:"));
};

describe("generateBufGenYaml without auth or events", () => {
    it("is exactly what it was before option imports existed (no inputs, no map_imports)", () => {
        // A scaffold that imports nothing from Connectum must not change shape: the default
        // workspace input is what every other scaffold cell has always been verified with.
        assert.equal(
            generateBufGenYaml(config({})),
            "version: v2\nclean: true\nplugins:\n  - local: protoc-gen-es\n    out: gen\n    opt:\n      - target=ts\n      - import_extension=.ts\n      - erasable_syntax=true\n",
        );
        assert.doesNotMatch(generateBufGenYaml(config({ catalog: true, otel: true })), /inputs:|map_imports/);
    });
});

describe("generateBufGenYaml with auth and/or events", () => {
    it("auth: one `directory: proto` input and the auth mapping on protoc-gen-es", () => {
        const yaml = generateBufGenYaml(config(AUTH));
        // Without the pinned input buf would generate the auth module under node_modules,
        // i.e. the local options_pb.ts this change removes.
        assert.equal(inputsBlock(yaml), "inputs:\n  - directory: proto\n");
        const es = pluginBlocks(yaml).get("protoc-gen-es") ?? "";
        assert.match(es, /\n {6}- map_imports=connectum\/auth\/v1\/:@connectum\/auth\/gen\n/);
        assert.doesNotMatch(es, /connectum\/events/);
    });

    it("events: the vendored option proto's directory is excluded from generation", () => {
        const yaml = generateBufGenYaml(config(EVENTS));
        assert.equal(inputsBlock(yaml), "inputs:\n  - directory: proto\n    exclude_paths:\n      - proto/connectum/events/v1\n");
        assert.match(pluginBlocks(yaml).get("protoc-gen-es") ?? "", /\n {6}- map_imports=connectum\/events\/v1\/:@connectum\/events\/gen\n/);
    });

    it("auth + events + catalog: one input (two would clobber catalog.gen.ts), both mappings, none on the catalog plugin", () => {
        const yaml = generateBufGenYaml(config(ALL));
        assert.equal((yaml.match(/- directory:/g) ?? []).length, 1);
        const blocks = pluginBlocks(yaml);
        const es = blocks.get("protoc-gen-es") ?? "";
        assert.match(es, /map_imports=connectum\/auth\/v1\/:@connectum\/auth\/gen/);
        assert.match(es, /map_imports=connectum\/events\/v1\/:@connectum\/events\/gen/);
        assert.match(es, /- erasable_syntax=true/);
        // The catalog plugin rejects every option it does not know.
        assert.doesNotMatch(blocks.get("protoc-gen-connectum-catalog") ?? "", /map_imports|erasable_syntax/);
    });

    it("maps the directory the option protos are imported from", () => {
        // A mapping that misses the import path silently leaves the local generation in place.
        assert.match(generateEventsOptionsProto(), /^package connectum\.events\.v1;$/m);
        assert.match(generateServiceProto("billing", true), /^import "connectum\/events\/v1\/options\.proto";$/m);
        for (const { protoDir } of optionProtoImports(config(ALL))) {
            assert.match(protoDir, /^connectum\/(auth|events)\/v1\/$/);
        }
    });
});

describe("events option proto written by the CLI", () => {
    const excluded = (yaml: string): string[] => [...yaml.matchAll(/^ {6}- (\S+)$/gm)].map((m) => m[1] ?? "").filter((p) => p.startsWith("proto/"));

    it("init --events writes it inside the excluded directory", () => {
        const base = new Map([
            ["package.json", JSON.stringify({ name: "base", dependencies: { "@connectum/core": "^1.3.0" }, devDependencies: {} })],
            ["src/services/greeterService.ts", "export const greeterService = {};\n"],
        ]);
        const out = transformBase(base, config(EVENTS));
        const dirs = excluded(out.get("buf.gen.yaml") ?? "");
        assert.ok(out.has(EVENTS_OPTIONS_PROTO_PATH));
        assert.ok(
            dirs.some((dir) => EVENTS_OPTIONS_PROTO_PATH.startsWith(`${dir}/`)),
            `${EVENTS_OPTIONS_PROTO_PATH} is not under ${dirs.join(", ")}`,
        );
    });

    it("generate service --with-events writes it at the same path, so an events project keeps not generating it", () => {
        // If the two paths drifted apart, the service's option proto would be generated
        // locally again and its descriptor would no longer come from @connectum/events.
        const files = buildServiceFiles("billing", true);
        assert.equal(files.get(EVENTS_OPTIONS_PROTO_PATH), generateEventsOptionsProto());
        const dirs = excluded(generateBufGenYaml(config(EVENTS)));
        assert.ok(dirs.some((dir) => EVENTS_OPTIONS_PROTO_PATH.startsWith(`${dir}/`)));
    });

    it("declares what @connectum/events publishes", () => {
        // buf compiles the vendored copy while the generated code imports the package's
        // descriptor; differing declarations would make the two disagree.
        const declarations = (proto: string): string =>
            proto
                .split("\n")
                .map((line) => line.replace(/\/\/.*$/, "").trim())
                .filter((line) => line.length > 0)
                .join("\n");
        const published = readFileSync(new URL("../../../events/proto/connectum/events/v1/options.proto", import.meta.url), "utf8");
        assert.equal(declarations(generateEventsOptionsProto()), declarations(published));
    });
});

describe("the Connectum slice floor follows the option imports", () => {
    it("is triggered by exactly the packages buf.gen.yaml maps imports to", () => {
        // A mapping added without a floor would let a project resolve a release that does
        // not export the subpath; a floor without a mapping would block versions for nothing.
        assert.deepEqual(
            optionProtoImports(config(ALL))
                .map(({ pkg }) => pkg)
                .sort(),
            [...CONNECTUM_SLICE_FLOOR.triggers].sort(),
        );
    });

    it("an older base picked with --ref: every @connectum/* moves to one range at the floor", () => {
        const base = new Map([
            [
                "package.json",
                JSON.stringify({
                    name: "base",
                    dependencies: { "@connectum/core": "^1.0.0", "@connectum/healthcheck": "^1.0.0", "@connectum/reflection": "^1.0.0" },
                    devDependencies: {},
                }),
            ],
            ["src/services/greeterService.ts", "export const greeterService = {};\n"],
            ["proto/greeter/v1/greeter.proto", 'syntax = "proto3";\n\npackage greeter.v1;\n\nservice GreeterService {\n  rpc SayHello(SayHelloRequest) returns (SayHelloResponse) {}\n}\n'],
        ]);
        for (const modules of [AUTH, EVENTS, ALL]) {
            const pkg = JSON.parse(transformBase(base, config(modules)).get("package.json") ?? "{}");
            const connectum = [...Object.entries(pkg.dependencies), ...Object.entries(pkg.devDependencies)].filter(([name]) => name.startsWith("@connectum/"));
            assert.ok(connectum.length >= 5);
            for (const [name, range] of connectum) {
                assert.equal(range, "^1.3.0", `${name} with ${JSON.stringify(modules)}`);
            }
            assert.deepEqual(connectumSliceViolations(pkg), []);
        }
    });

    it("without auth or events the base's ranges are kept", () => {
        const base = new Map([
            ["package.json", JSON.stringify({ name: "base", dependencies: { "@connectum/core": "^1.0.0", "@connectum/healthcheck": "^1.0.0" }, devDependencies: {} })],
            ["src/services/greeterService.ts", "export const greeterService = {};\n"],
        ]);
        const pkg = JSON.parse(transformBase(base, config({ otel: true, catalog: true })).get("package.json") ?? "{}");
        assert.equal(pkg.dependencies["@connectum/core"], "^1.0.0");
        assert.equal(pkg.dependencies["@connectum/otel"], "^1.0.0");
        assert.equal(pkg.devDependencies["@connectum/testing"], "^1.0.0");
        assert.equal(pkg.devDependencies["@connectum/protoc-gen-catalog"], "^1.0.0");
    });
});

describe("the shared @connectum/* range is the highest requirement of the base", () => {
    /** Every @connectum/* entry of the scaffolded manifest, both sections. */
    const connectumRanges = (base: Record<string, unknown>, modules: ModuleSelection): Map<string, string> => {
        const files = new Map([
            ["package.json", JSON.stringify({ name: "base", ...base })],
            ["src/services/greeterService.ts", "export const greeterService = {};\n"],
            ["proto/greeter/v1/greeter.proto", 'syntax = "proto3";\n\npackage greeter.v1;\n\nservice GreeterService {\n  rpc SayHello(SayHelloRequest) returns (SayHelloResponse) {}\n}\n'],
        ]);
        const pkg = JSON.parse(transformBase(files, config(modules)).get("package.json") ?? "{}");
        return new Map(
            [...Object.entries(pkg.dependencies as Record<string, string>), ...Object.entries(pkg.devDependencies as Record<string, string>)].filter(([name]) =>
                name.startsWith("@connectum/"),
            ),
        );
    };
    const allEqual = (ranges: Map<string, string>, expected: string): void => {
        assert.ok(ranges.size >= 3, `expected several @connectum/* entries, got ${[...ranges.keys()].join(", ")}`);
        for (const [name, range] of ranges) {
            assert.equal(range, expected, name);
        }
    };

    it("a --ref base with core ^1.2.0 and events ^1.4.0: every entry becomes ^1.4.0, none is lowered to the floor", () => {
        // Deriving the range from @connectum/core alone would rewrite events down to ^1.3.0.
        allEqual(connectumRanges({ dependencies: { "@connectum/core": "^1.2.0", "@connectum/events": "^1.4.0" } }, EVENTS), "^1.4.0");
    });

    it("a base entirely at the floor stays at the floor", () => {
        allEqual(connectumRanges({ dependencies: { "@connectum/core": "^1.3.0", "@connectum/healthcheck": "^1.3.0" } }, AUTH), "^1.3.0");
    });

    it("one entry above the rest lifts the whole set to it", () => {
        allEqual(
            connectumRanges({ dependencies: { "@connectum/core": "^1.3.0", "@connectum/healthcheck": "^1.3.0", "@connectum/reflection": "^1.5.2" } }, AUTH),
            "^1.5.2",
        );
    });

    it("base devDependencies take part (e.g. @connectum/testing ^1.6.0)", () => {
        allEqual(connectumRanges({ dependencies: { "@connectum/core": "^1.2.0" }, devDependencies: { "@connectum/testing": "^1.6.0" } }, ALL), "^1.6.0");
    });

    it("tilde and exact ranges count by their lower bound; the shared range is written as a caret range", () => {
        allEqual(connectumRanges({ dependencies: { "@connectum/core": "~1.4.2", "@connectum/healthcheck": "1.3.0" } }, AUTH), "^1.4.2");
    });

    it("ranges whose lower bound cannot be read (>=, *, tags, prereleases) do not raise the set and are replaced by it", () => {
        allEqual(
            connectumRanges({ dependencies: { "@connectum/core": "^1.2.0", "@connectum/healthcheck": ">=1.9.0", "@connectum/reflection": "latest", "@connectum/interceptors": "^1.8.0-rc.1" } }, AUTH),
            "^1.3.0",
        );
    });
});

describe("slice floor helpers", () => {
    it("connectumSliceFloorApplies only with a trigger in dependencies", () => {
        assert.equal(connectumSliceFloorApplies({ "@connectum/auth": "^1.0.0" }), true);
        assert.equal(connectumSliceFloorApplies({ "@connectum/events": "^1.0.0" }), true);
        assert.equal(connectumSliceFloorApplies({ "@connectum/events-nats": "^1.0.0", "@connectum/core": "^1.0.0" }), false);
    });

    it("connectumSliceRange: the highest readable @connectum/* lower bound of both sections, never below the floor", () => {
        assert.equal(connectumSliceRange({ dependencies: { "@connectum/core": "^1.2.0" } }), "^1.3.0");
        assert.equal(connectumSliceRange({ dependencies: { "@connectum/core": "^1.4.1" } }), "^1.4.1");
        assert.equal(connectumSliceRange({ dependencies: { "@connectum/core": "^1.2.0", "@connectum/events": "^1.4.0" } }), "^1.4.0");
        assert.equal(connectumSliceRange({ dependencies: { "@connectum/core": "^1.2.0" }, devDependencies: { "@connectum/testing": "^1.6.0" } }), "^1.6.0");
        assert.equal(connectumSliceRange({ dependencies: { "@connectum/core": "^1.10.0", "@connectum/auth": "^1.9.9" } }), "^1.10.0", "numeric, not lexical");
        assert.equal(connectumSliceRange({ dependencies: { "@connectum/core": ">=1.9.0" } }), "^1.3.0", "an unreadable range does not raise the set");
        assert.equal(connectumSliceRange({ dependencies: { "@bufbuild/protobuf": "^2.16.0" } }), "^1.3.0", "other scopes are ignored");
        assert.equal(connectumSliceRange({}), "^1.3.0");
    });

    it("alignConnectumSlice rewrites only the @connectum/ scope and does not mutate its input", () => {
        const input = { "@connectum/core": "^1.0.0", "@bufbuild/protobuf": "^2.16.0" };
        assert.deepEqual(alignConnectumSlice(input, "^1.3.0"), { "@connectum/core": "^1.3.0", "@bufbuild/protobuf": "^2.16.0" });
        assert.equal(input["@connectum/core"], "^1.0.0");
    });

    it("connectumSliceViolations reports a mixed slice and ranges below the floor", () => {
        const problems = connectumSliceViolations({
            dependencies: { "@connectum/auth": "^1.3.0", "@connectum/core": "^1.2.0" },
            devDependencies: { "@connectum/testing": "^1.3.0" },
        });
        assert.equal(problems.length, 2);
        assert.match(problems[0] ?? "", /ranges differ/);
        assert.match(problems[1] ?? "", /@connectum\/core is "\^1\.2\.0", below the floor 1\.3\.0/);
        assert.deepEqual(connectumSliceViolations({ dependencies: { "@connectum/core": "^1.0.0" } }), []);
    });
});
