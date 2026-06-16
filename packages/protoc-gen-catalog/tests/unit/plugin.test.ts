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
import { create, fromBinary } from "@bufbuild/protobuf";
import { CodeGeneratorRequestSchema, type FileDescriptorProto, FileDescriptorProtoSchema } from "@bufbuild/protobuf/wkt";
import { protocGenCatalog } from "../../src/plugin.ts";

const here = dirname(fileURLToPath(import.meta.url));

function fdpFromFixture(relPbPath: string): FileDescriptorProto {
    const src = readFileSync(join(here, "../fixtures", relPbPath), "utf8");
    const match = src.match(/fileDesc\(\s*"([^"]+)"/);
    if (match === null || match[1] === undefined) throw new Error(`no fileDesc in ${relPbPath}`);
    return fromBinary(FileDescriptorProtoSchema, Buffer.from(match[1], "base64"));
}

function generate(fileToGenerate: string[], parameter = "target=ts,import_extension=.js"): { name: string; content: string } {
    const request = create(CodeGeneratorRequestSchema, {
        fileToGenerate,
        parameter,
        protoFile: [fdpFromFixture("echo/v1/echo_pb.ts"), fdpFromFixture("streaming/v1/streaming_pb.ts")],
    });
    const response = protocGenCatalog.run(request);
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
        assert.match(content, /"echo\.v1\.EchoService\/Echo": \{ request: EchoRequest; response: EchoResponse \};/);
        // StreamingService.Echo is unary → in CallMap
        assert.match(content, /"streaming\.v1\.StreamingService\/Echo": \{ request: Item; response: Item \};/);
    });

    it("augments ConnectumStreamMap with kebab-cased kinds", () => {
        const { content } = generate(["streaming/v1/streaming.proto"]);
        assert.match(content, /interface ConnectumStreamMap \{/);
        assert.match(content, /"streaming\.v1\.StreamingService\/Server": \{ request: Item; response: Item; kind: "server-stream" \};/);
        assert.match(content, /"streaming\.v1\.StreamingService\/Client": \{ request: Item; response: Count; kind: "client-stream" \};/);
        assert.match(content, /"streaming\.v1\.StreamingService\/Bidi": \{ request: Item; response: Item; kind: "bidi" \};/);
    });

    it("does NOT place a streaming method in ConnectumCallMap", () => {
        const { content } = generate(["streaming/v1/streaming.proto"]);
        const callMap = content.slice(content.indexOf("interface ConnectumCallMap"), content.indexOf("interface ConnectumStreamMap"));
        assert.doesNotMatch(callMap, /\/Server"/);
        assert.doesNotMatch(callMap, /\/Bidi"/);
    });

    it("honours the output_file option", () => {
        const { name } = generate(["echo/v1/echo.proto"], "target=ts,output_file=catalog/index.gen.ts");
        assert.strictEqual(name, "catalog/index.gen.ts");
    });

    it("rejects an output_file that escapes the output root", () => {
        assert.throws(() => generate(["echo/v1/echo.proto"], "target=ts,output_file=../escape.ts"), /relative path inside the output root/);
        assert.throws(() => generate(["echo/v1/echo.proto"], "target=ts,output_file=/abs.ts"), /relative path inside the output root/);
    });

    it("emits a valid empty catalog with no augmentation when nothing is generated", () => {
        const { content } = generate([]);
        assert.match(content, /export const serviceCatalog = Object\.freeze\(\{\}\);/);
        assert.doesNotMatch(content, /declare module/);
    });
});
