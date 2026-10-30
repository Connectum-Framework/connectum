/**
 * protoc-gen-connectum-catalog — in-process generation tests.
 *
 * Drives the plugin via `plugin.run(CodeGeneratorRequest)` (no buf subprocess)
 * against the echo + streaming proto fixtures and asserts the generated
 * `catalog.gen.ts` content: runtime catalog, `@connectum/core` augmentation,
 * kebab-cased stream kinds, `.js` relative imports, empty-input handling, and
 * the `output_file` option (incl. traversal rejection).
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { create, createFileRegistry, fromBinary, type MessageInitShape } from "@bufbuild/protobuf";
import { CodeGeneratorRequestSchema, type FileDescriptorProto, FileDescriptorProtoSchema, FileDescriptorSetSchema } from "@bufbuild/protobuf/wkt";
import { protocGenCatalog } from "../../src/plugin.ts";

const here = dirname(fileURLToPath(import.meta.url));

function fdpFromFixture(relPbPath: string): FileDescriptorProto {
    const src = readFileSync(join(here, "../fixtures", relPbPath), "utf8");
    const match = src.match(/fileDesc\(\s*"([^"]+)"/);
    if (match === null || match[1] === undefined) throw new Error(`no fileDesc in ${relPbPath}`);
    return fromBinary(FileDescriptorProtoSchema, Buffer.from(match[1], "base64"));
}

function runPlugin(fileToGenerate: string[], parameter: string, extraFiles: FileDescriptorProto[] = []) {
    const request = create(CodeGeneratorRequestSchema, {
        fileToGenerate,
        parameter,
        protoFile: [fdpFromFixture("echo/v1/echo_pb.ts"), fdpFromFixture("streaming/v1/streaming_pb.ts"), ...extraFiles],
    });
    return protocGenCatalog.run(request);
}

function generate(fileToGenerate: string[], parameter = "target=ts,import_extension=.js", extraFiles: FileDescriptorProto[] = []): { name: string; content: string } {
    const response = runPlugin(fileToGenerate, parameter, extraFiles);
    assert.strictEqual(response.error, "", `plugin reported an error: ${response.error}`);
    const file = response.file[0];
    assert.ok(file, "plugin produced no file");
    return { name: file.name, content: file.content };
}

describe("protoc-gen-connectum-catalog — generation", () => {
    it("emits the mandatory @connectum/core type-load import", () => {
        const { content } = generate(["echo/v1/echo.proto"]);
        assert.match(content, /import type \{\} from "@connectum\/core";/);
    });

    it("emits a runtime serviceCatalog keyed by typeName", () => {
        const { name, content } = generate(["echo/v1/echo.proto", "streaming/v1/streaming.proto"]);
        assert.strictEqual(name, "catalog.gen.ts");
        assert.match(content, /export const serviceCatalog = \{/);
        assert.match(content, /"echo\.v1\.EchoService": EchoService,/);
        assert.match(content, /"streaming\.v1\.StreamingService": StreamingService,/);
        assert.match(content, /\} as const;/);
    });

    it("imports descriptors and shapes with .js relative specifiers", () => {
        const { content } = generate(["echo/v1/echo.proto"]);
        assert.match(content, /from "\.\/echo\/v1\/echo_pb\.js"/);
        assert.doesNotMatch(content, /echo_pb\.ts/);
    });

    it("augments ConnectumCallMap for unary methods only", () => {
        const { content } = generate(["echo/v1/echo.proto", "streaming/v1/streaming.proto"]);
        assert.match(content, /interface ConnectumCallMap \{/);
        assert.match(content, /"echo\.v1\.EchoService\/Echo": \{ request: MessageInitShape<typeof EchoRequestSchema>; response: EchoResponse \};/);
        // StreamingService.Echo is unary → in CallMap
        assert.match(content, /"streaming\.v1\.StreamingService\/Echo": \{ request: MessageInitShape<typeof ItemSchema>; response: Item \};/);
        assert.match(content, /import type \{ EchoRequestSchema, EchoResponse \} from "\.\/echo\/v1\/echo_pb\.js";/);
        assert.match(content, /import type \{ MessageInitShape \} from "@bufbuild\/protobuf";/);
    });

    it("augments ConnectumStreamMap with kebab-cased kinds", () => {
        const { content } = generate(["streaming/v1/streaming.proto"]);
        assert.match(content, /interface ConnectumStreamMap \{/);
        assert.match(content, /"streaming\.v1\.StreamingService\/Server": \{ request: MessageInitShape<typeof ItemSchema>; response: Item; kind: "server-stream" \};/);
        assert.match(content, /"streaming\.v1\.StreamingService\/Client": \{ request: MessageInitShape<typeof ItemSchema>; response: Count; kind: "client-stream" \};/);
        assert.match(content, /"streaming\.v1\.StreamingService\/Bidi": \{ request: MessageInitShape<typeof ItemSchema>; response: Item; kind: "bidi" \};/);
    });

    it("does NOT place any streaming method (server, client or bidi) in ConnectumCallMap", () => {
        const { content } = generate(["streaming/v1/streaming.proto"]);
        const callMapStart = content.indexOf("interface ConnectumCallMap");
        const streamMapStart = content.indexOf("interface ConnectumStreamMap");
        // Both maps must exist and be in this order, otherwise the slice below would not isolate CallMap.
        assert.ok(callMapStart >= 0 && streamMapStart > callMapStart, "CallMap must precede StreamMap");
        const callMap = content.slice(callMapStart, streamMapStart);
        // The only unary method of the streaming service is its own Echo.
        assert.match(callMap, /"streaming\.v1\.StreamingService\/Echo":/);
        for (const streaming of ["Server", "Client", "Bidi"]) {
            assert.doesNotMatch(callMap, new RegExp(`/${streaming}"`), `${streaming} streaming method leaked into ConnectumCallMap`);
        }
        // Conversely a unary method must not appear in StreamMap.
        const streamMap = content.slice(streamMapStart);
        assert.doesNotMatch(streamMap, /StreamingService\/Echo"/);
    });

    it("honours the output_file option and leaves the generated content unchanged", () => {
        const inputs = ["echo/v1/echo.proto", "streaming/v1/streaming.proto"];
        const byDefault = generate(inputs);
        // `gen/catalog.ts` is the example given by the service-catalog specification.
        const custom = generate(inputs, "target=ts,import_extension=.js,output_file=gen/catalog.ts");
        assert.strictEqual(custom.name, "gen/catalog.ts");
        // Relative imports of the *_pb modules are resolved from the catalog's own directory: one level
        // deeper means `./` becomes `../`. Everything else must be identical.
        assert.strictEqual(custom.content, byDefault.content.replaceAll('from "./', 'from "../'));
        assert.strictEqual(byDefault.name, "catalog.gen.ts");
    });

    // The README states that the plugin emits TypeScript only: the module augmentation that types
    // `ctx.call` is a `declare module` block, which a `.js` file cannot hold and a transpiled `.d.ts`
    // does not carry. The standard `target` option of @bufbuild/protoplugin would otherwise
    // transpile the TypeScript output into exactly those files, silently leaving every key untyped,
    // and it defaults to `js+dts` when no target is given.
    describe("target", () => {
        for (const target of ["js", "dts", "js+dts", "ts+js", "ts+dts", "ts+js+dts"]) {
            it(`rejects target=${target}, saying that the catalog is TypeScript only and what to use`, () => {
                assert.throws(
                    () => runPlugin(["echo/v1/echo.proto"], `target=${target},import_extension=.js`),
                    (err: Error) =>
                        err.message.includes("protoc-gen-connectum-catalog") &&
                        err.message.includes(`target "${target}"`) &&
                        /TypeScript only/.test(err.message) &&
                        err.message.includes("target=ts"),
                );
            });
        }

        it("rejects a missing target, which the plugin protocol reads as js+dts, and names the default", () => {
            assert.throws(
                () => runPlugin(["echo/v1/echo.proto"], "import_extension=.js"),
                (err: Error) => err.message.includes('target "js+dts"') && err.message.includes("when no target is given") && err.message.includes("target=ts"),
            );
            assert.throws(() => runPlugin(["echo/v1/echo.proto"], ""), /target=ts/);
        });

        it("writes exactly one file, catalog.gen.ts, for target=ts", () => {
            const response = runPlugin(["echo/v1/echo.proto"], "target=ts,import_extension=.js");
            assert.deepStrictEqual(
                response.file.map((file) => file.name),
                ["catalog.gen.ts"],
            );
        });

        it("rejects the unsupported target whatever else the option list holds, including a custom output_file", () => {
            assert.throws(() => runPlugin(["echo/v1/echo.proto"], "target=dts,output_file=gen/catalog.gen.ts"), /TypeScript only/);
        });
    });

    describe("output_file safety", () => {
        // Absolute paths and `..` traversal must be refused with an error naming the path and the rule,
        // and nothing may be written. Windows drive, UNC and backslash forms are covered by the package README.
        const unsafe = [
            { value: "../escape.ts", desc: "parent traversal at the start" },
            { value: "a/../b.ts", desc: "parent traversal in the middle" },
            { value: "a\\..\\b.ts", desc: "parent traversal with backslash separators" },
            { value: "/etc/catalog.ts", desc: "POSIX absolute path" },
            { value: "C:\\x.ts", desc: "Windows drive path with backslash" },
            { value: "C:/x.ts", desc: "Windows drive path with slash" },
            { value: "\\\\srv\\sh\\x.ts", desc: "Windows UNC path" },
        ];
        for (const { value, desc } of unsafe) {
            it(`rejects ${desc}`, () => {
                // The plugin fails before producing any response, so no file can be written.
                assert.throws(
                    () => runPlugin(["echo/v1/echo.proto"], `target=ts,output_file=${value}`),
                    (err: Error) => err.message.includes(value) && /relative path inside the output root/.test(err.message),
                );
            });
        }

        it("accepts a nested relative path that merely contains dots in names", () => {
            const { name } = generate(["echo/v1/echo.proto"], "target=ts,output_file=gen/v1.0/..catalog.ts");
            assert.strictEqual(name, "gen/v1.0/..catalog.ts");
        });

        it("rejects any option other than output_file", () => {
            assert.throws(
                () => runPlugin(["echo/v1/echo.proto"], "target=ts,out_file=x.ts"),
                (err: Error) => err.message.includes("out_file") && /unknown option/.test(err.message),
            );
        });
    });

    it("reports the package version in the preamble and as the plugin version", () => {
        const manifest = JSON.parse(readFileSync(join(here, "../../package.json"), "utf8")) as { version: string };
        assert.match(manifest.version, /^\d+\.\d+\.\d+/);
        const { content } = generate(["echo/v1/echo.proto"]);
        assert.ok(
            content.includes(`// @generated by protoc-gen-connectum-catalog v${manifest.version}. DO NOT EDIT.`),
            `preamble does not carry v${manifest.version}`,
        );
        assert.strictEqual(protocGenCatalog.version, `v${manifest.version}`);
    });

    it("routes every method of every input service to the map for its kind, derived from the proto descriptors", () => {
        const files = ["echo/v1/echo.proto", "streaming/v1/streaming.proto"];
        const { content } = generate(files);
        const registry = createFileRegistry(
            create(FileDescriptorSetSchema, { file: [fdpFromFixture("echo/v1/echo_pb.ts"), fdpFromFixture("streaming/v1/streaming_pb.ts")] }),
        );
        const kinds = { server_streaming: "server-stream", client_streaming: "client-stream", bidi_streaming: "bidi" } as const;
        const expectedCalls: string[] = [];
        const expectedStreams: string[] = [];
        for (const file of files) {
            const desc = registry.getFile(file);
            assert.ok(desc, `descriptor for ${file}`);
            for (const service of desc.services) {
                for (const method of service.methods) {
                    const key = `${service.typeName}/${method.name}`;
                    if (method.methodKind === "unary") expectedCalls.push(key);
                    else expectedStreams.push(`${key}|${kinds[method.methodKind]}`);
                }
            }
        }
        const streamMapStart = content.indexOf("interface ConnectumStreamMap");
        const callSection = content.slice(content.indexOf("interface ConnectumCallMap"), streamMapStart);
        const streamSection = content.slice(streamMapStart);
        const actualCalls = [...callSection.matchAll(/^\s+"([^"]+)": \{ request:/gm)].map((m) => m[1]);
        const actualStreams = [...streamSection.matchAll(/^\s+"([^"]+)": \{ request:.*kind: "([^"]+)" \};$/gm)].map((m) => `${m[1]}|${m[2]}`);
        // Order is declaration order: files as listed, services and methods as declared.
        assert.deepStrictEqual(actualCalls, expectedCalls);
        assert.deepStrictEqual(actualStreams, expectedStreams);
        assert.ok(expectedCalls.length >= 4 && expectedStreams.length === 3, "fixtures must keep covering all four kinds");
        // A single augmentation block carries both maps.
        assert.strictEqual(content.split('declare module "@connectum/core"').length - 1, 1);
    });

    it("pins the full generated layout of a two-file catalog (layout literals are the current output, not an external layout)", () => {
        const { content } = generate(["echo/v1/echo.proto", "streaming/v1/streaming.proto"]);
        const text = content.replace(/protoc-gen-connectum-catalog v\S+\. DO NOT EDIT/, "protoc-gen-connectum-catalog v<version>. DO NOT EDIT");
        const expected = [
            'import type { EchoRequestSchema, EchoResponse } from "./echo/v1/echo_pb.js";',
            'import { EchoService } from "./echo/v1/echo_pb.js";',
            'import type { Count, Item, ItemSchema } from "./streaming/v1/streaming_pb.js";',
            'import { StreamingService } from "./streaming/v1/streaming_pb.js";',
            'import type { MessageInitShape } from "@bufbuild/protobuf";',
            "",
            "// @generated by protoc-gen-connectum-catalog v<version>. DO NOT EDIT.",
            'import type {} from "@connectum/core";',
            "",
            "export const serviceCatalog = {",
            '    "echo.v1.EchoService": EchoService,',
            '    "streaming.v1.StreamingService": StreamingService,',
            "} as const;",
            "",
            'declare module "@connectum/core" {',
            "    interface ConnectumCallMap {",
            '        "echo.v1.EchoService/Echo": { request: MessageInitShape<typeof EchoRequestSchema>; response: EchoResponse };',
            '        "echo.v1.EchoService/SecureEcho": { request: MessageInitShape<typeof EchoRequestSchema>; response: EchoResponse };',
            '        "echo.v1.EchoService/RateLimitedEcho": { request: MessageInitShape<typeof EchoRequestSchema>; response: EchoResponse };',
            '        "streaming.v1.StreamingService/Echo": { request: MessageInitShape<typeof ItemSchema>; response: Item };',
            "    }",
            "    interface ConnectumStreamMap {",
            '        "streaming.v1.StreamingService/Server": { request: MessageInitShape<typeof ItemSchema>; response: Item; kind: "server-stream" };',
            '        "streaming.v1.StreamingService/Client": { request: MessageInitShape<typeof ItemSchema>; response: Count; kind: "client-stream" };',
            '        "streaming.v1.StreamingService/Bidi": { request: MessageInitShape<typeof ItemSchema>; response: Item; kind: "bidi" };',
            "    }",
            "}",
            "",
        ].join("\n");
        assert.strictEqual(text, expected);
    });

    // The relative module specifiers take the extension from the standard `import_extension`
    // option: none by default, `.js` for compiled contracts, `.ts` for source ones.
    describe("import_extension", () => {
        const cases: Array<{ parameter: string; specifier: string }> = [
            { parameter: "target=ts", specifier: "./echo/v1/echo_pb" },
            { parameter: "target=ts,import_extension=.js", specifier: "./echo/v1/echo_pb.js" },
            { parameter: "target=ts,import_extension=.ts", specifier: "./echo/v1/echo_pb.ts" },
        ];
        for (const { parameter, specifier } of cases) {
            it(`${parameter} imports the descriptors from "${specifier}"`, () => {
                const { content } = generate(["echo/v1/echo.proto"], parameter);
                const specifiers = [...content.matchAll(/from "(\.[^"]+)"/g)].map((m) => m[1]);
                assert.ok(specifiers.length > 0, "the catalog must import the generated descriptors");
                assert.deepStrictEqual([...new Set(specifiers)], [specifier]);
            });
        }
    });

    // Catalogs are built from synthetic descriptors for shapes the echo and streaming fixtures
    // do not have: several services in one file, files without services, and one message name
    // used by two packages.
    describe("shapes beyond the fixtures", () => {
        function protoFile(init: MessageInitShape<typeof FileDescriptorProtoSchema>): FileDescriptorProto {
            return create(FileDescriptorProtoSchema, { syntax: "proto3", ...init });
        }
        const multi = protoFile({
            name: "multi/v1/multi.proto",
            package: "multi.v1",
            messageType: [{ name: "Req" }, { name: "Res" }],
            service: [
                {
                    name: "First",
                    method: [
                        { name: "One", inputType: ".multi.v1.Req", outputType: ".multi.v1.Res" },
                        { name: "Many", inputType: ".multi.v1.Req", outputType: ".multi.v1.Res", serverStreaming: true },
                    ],
                },
                { name: "Second", method: [{ name: "Two", inputType: ".multi.v1.Req", outputType: ".multi.v1.Res", clientStreaming: true }] },
            ],
        });
        const messagesOnly = protoFile({ name: "plain/v1/plain.proto", package: "plain.v1", messageType: [{ name: "Only" }] });

        it("lists every service of a file with several services, in declaration order, with every method in the map of its kind", () => {
            const { content } = generate(["multi/v1/multi.proto"], "target=ts,import_extension=.js", [multi]);

            const catalogKeys = [...content.matchAll(/^ {4}"([^"]+)": \w+,$/gm)].map((m) => m[1]);
            assert.deepStrictEqual(catalogKeys, ["multi.v1.First", "multi.v1.Second"]);

            const callMapStart = content.indexOf("interface ConnectumCallMap");
            const streamMapStart = content.indexOf("interface ConnectumStreamMap");
            const entries = (section: string) => [...section.matchAll(/^ {8}"([^"]+)": \{ request:.*?(?:kind: "([^"]+)" )?\};$/gm)].map((m) => `${m[1]}${m[2] ? `|${m[2]}` : ""}`);
            assert.deepStrictEqual(entries(content.slice(callMapStart, streamMapStart)), ["multi.v1.First/One"]);
            assert.deepStrictEqual(entries(content.slice(streamMapStart)), ["multi.v1.First/Many|server-stream", "multi.v1.Second/Two|client-stream"]);
        });

        it("skips a file without services among the files to generate and still lists the others", () => {
            const { content } = generate(["plain/v1/plain.proto", "multi/v1/multi.proto"], "target=ts,import_extension=.js", [messagesOnly, multi]);
            const catalogKeys = [...content.matchAll(/^ {4}"([^"]+)": \w+,$/gm)].map((m) => m[1]);
            assert.deepStrictEqual(catalogKeys, ["multi.v1.First", "multi.v1.Second"]);
        });

        it("treats files without services as an empty catalog: no augmentation, no failure", () => {
            const { content } = generate(["plain/v1/plain.proto"], "target=ts,import_extension=.js", [messagesOnly]);
            assert.match(content, /^export const serviceCatalog = Object\.freeze\(\{\}\);$/m);
            assert.doesNotMatch(content, /declare module/);
        });

        // Two packages may each declare a message called `Item`. In the generated file every type
        // name must still denote the message of its own package; the identifiers themselves are
        // free, so they are resolved through the import statements.
        it("keeps same-named messages of different packages apart", () => {
            const owner = (pkg: string) =>
                protoFile({
                    name: `${pkg}/v1/${pkg}.proto`,
                    package: `${pkg}.v1`,
                    messageType: [{ name: "Item" }],
                    service: [{ name: "Svc", method: [{ name: "Get", inputType: `.${pkg}.v1.Item`, outputType: `.${pkg}.v1.Item` }] }],
                });
            const { content } = generate(["alpha/v1/alpha.proto", "beta/v1/beta.proto"], "target=ts,import_extension=.js", [owner("alpha"), owner("beta")]);

            // local identifier -> where it comes from and under which exported name
            const bindings = new Map<string, { module: string; exported: string }>();
            for (const line of content.matchAll(/^import (?:type )?\{ ([^}]+) \} from "([^"]+)";$/gm)) {
                for (const specifier of (line[1] as string).split(",")) {
                    const [exported, local] = specifier.trim().split(/\s+as\s+/);
                    bindings.set((local ?? exported) as string, { module: line[2] as string, exported: exported as string });
                }
            }
            for (const pkg of ["alpha", "beta"]) {
                const entry = content.match(new RegExp(`"${pkg}\\.v1\\.Svc/Get": \\{ request: MessageInitShape<typeof ([\\w$]+)>; response: ([\\w$]+) \\};`));
                assert.ok(entry, `the ${pkg} method must be in ConnectumCallMap`);
                assert.deepStrictEqual(bindings.get(entry[1] as string), { module: `./${pkg}/v1/${pkg}_pb.js`, exported: "ItemSchema" }, `${pkg} request type`);
                assert.deepStrictEqual(bindings.get(entry[2] as string), { module: `./${pkg}/v1/${pkg}_pb.js`, exported: "Item" }, `${pkg} response type`);
            }
        });
    });

    describe("empty input", () => {
        // Run the plugin while capturing what it writes to stderr (restored in `finally`).
        function runCapturingStderr(files: string[]) {
            const writes: string[] = [];
            const original = process.stderr.write;
            process.stderr.write = ((chunk: string | Uint8Array) => {
                writes.push(String(chunk));
                return true;
            }) as typeof process.stderr.write;
            try {
                return { response: runPlugin(files, "target=ts,import_extension=.js"), writes };
            } finally {
                process.stderr.write = original;
            }
        }

        it("emits the empty catalog without augmentation, succeeds, and warns on stderr", () => {
            const { response, writes } = runCapturingStderr([]);
            // Success: failing on empty input breaks incremental buf workflows.
            assert.strictEqual(response.error, "");
            assert.strictEqual(response.file.length, 1);
            const content = response.file[0]?.content ?? "";
            assert.match(content, /^import type \{\} from "@connectum\/core";$/m);
            assert.match(content, /^export const serviceCatalog = Object\.freeze\(\{\}\);$/m);
            assert.doesNotMatch(content, /declare module/);
            assert.doesNotMatch(content, /ConnectumCallMap|ConnectumStreamMap/);
            assert.ok(
                writes.some((w) => /no services/i.test(w)),
                `a warning about missing services must be written to stderr, got: ${JSON.stringify(writes)}`,
            );
        });

        it("does not warn when services are present", () => {
            const { response, writes } = runCapturingStderr(["echo/v1/echo.proto"]);
            assert.strictEqual(response.error, "");
            assert.deepStrictEqual(writes, []);
        });
    });
});
