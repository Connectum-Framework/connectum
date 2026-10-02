/**
 * `connectum proto sync` end to end: the built CLI against a running server.
 *
 * The CLI is a reflection client of its own, so the server and the client could
 * share a mistake and still agree with each other. This suite checks the CLI
 * against two sources that know nothing about Connectum:
 *
 * - grpcurl (grpc-go) collects the descriptors of every service from the same
 *   server with `-protoset-out`. The CLI must list the same files and fetch the
 *   same bytes for each: both are bytes the server sent, so any difference is
 *   the CLI losing, duplicating or re-encoding a file.
 * - `buf generate` from the fixture sources. Code the CLI generates from the
 *   running server must equal code generated from the .proto files the server
 *   was built from. The sources are compiled with `--exclude-source-info`
 *   because reflection descriptors carry no comments.
 *
 * Not part of `pnpm test`: it needs Docker, the tools image and a build of the
 * CLI. Run from the repository root, then from this package:
 *
 *     pnpm build
 *     node scripts/interop-tools.mjs
 *     pnpm test:interop
 *
 * The clients reach the server through the host network, which Docker offers
 * on Linux only.
 */

import assert from "node:assert";
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { create } from "@bufbuild/protobuf";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createServer, defineService, type Server } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { Healthcheck } from "@connectum/healthcheck";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { Reflection } from "@connectum/reflection";
import { readFileDescriptorSet } from "../../../../tests/interop/descriptors.ts";
import { OUT_DIR, runTool } from "../../../../tests/interop/tools.ts";
// The reflection package's fixtures: a service with options, a oneof, nested
// types, extensions, well-known imports, and a file with an unmounted service.
import { Level, MetaSchema } from "../../../reflection/tests/fixtures/fixture/v1/common_pb.ts";
import { MountedService } from "../../../reflection/tests/fixtures/fixture/v1/multi_pb.ts";
import { FixtureService } from "../../../reflection/tests/fixtures/fixture/v1/service_pb.ts";
import { fetchFileDescriptorSetBinary } from "../../src/utils/reflection.ts";

const run = promisify(execFile);

const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const cliBinary = join(repositoryRoot, "packages/cli/dist/index.js");
const fixturesDir = join(repositoryRoot, "packages/reflection/tests/fixtures");
// `proto sync` runs `buf`, which runs `protoc-gen-es`; both come from this
// package's devDependencies, as they would from a user's project.
const toolPath = `${join(repositoryRoot, "packages/cli/node_modules/.bin")}:${process.env.PATH ?? ""}`;

/** Services in registration order: application services, then Healthcheck's. */
const MOUNTED = ["fixture.v1.FixtureService", "fixture.v1.MountedService", "grpc.health.v1.Health"];

/** The fixture sources behind the mounted services, which both generators must render identically. */
const FIXTURE_FILES = ["fixture/v1/common_pb.ts", "fixture/v1/legacy_pb.ts", "fixture/v1/multi_pb.ts", "fixture/v1/options_pb.ts", "fixture/v1/service_pb.ts"];

const fixtureService = defineService(FixtureService, {
    get: () => create(MetaSchema, { level: Level.HIGH }),
    ping: () => ({}),
});
const mountedService = defineService(MountedService, { ping: () => ({}) });

/** Every file under `dir`, as paths relative to it. */
function listFiles(dir: string): string[] {
    return readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((entry) => entry.isFile())
        .map((entry) => relative(dir, join(entry.parentPath, entry.name)))
        .sort();
}

/** The `  - item` lines that follow `heading` in the dry-run output. */
function listedUnder(output: string, heading: string): string[] {
    const lines = output.split("\n");
    const start = lines.indexOf(heading);
    assert.notStrictEqual(start, -1, `dry-run output has no "${heading}" section:\n${output}`);
    const items: string[] = [];
    for (const line of lines.slice(start + 1)) {
        if (!line.startsWith("  - ")) {
            break;
        }
        items.push(line.slice(4));
    }
    return items;
}

describe("connectum proto sync with a running server", () => {
    let server: Server;
    let address: string;
    let workDir: string;
    let grpcurlFiles: ReturnType<typeof readFileDescriptorSet>;

    before(async () => {
        server = createServer({
            services: [fixtureService, mountedService],
            port: 0,
            protocols: [Healthcheck(), Reflection()],
            interceptors: [],
            allowHTTP1: false,
        });
        await server.start();
        assert.ok(server.address?.port);
        address = `127.0.0.1:${server.address.port}`;

        mkdirSync(join(repositoryRoot, ".tmp"), { recursive: true });
        workDir = mkdtempSync(join(repositoryRoot, ".tmp", "interop-cli-"));

        // `describe` without a symbol walks every listed service; -protoset-out
        // writes each file it needed, with its imports, as a FileDescriptorSet.
        const result = await runTool("grpcurl", ["-plaintext", "-protoset-out", `${OUT_DIR}/grpcurl.binpb`, address, "describe"], { outDir: workDir });
        assert.strictEqual(result.code, 0, `grpcurl describe exited with ${result.code}: ${result.stderr}`);
        grpcurlFiles = readFileDescriptorSet(readFileSync(join(workDir, "grpcurl.binpb")));
    });

    after(async () => {
        await server?.stop();
        if (workDir) {
            rmSync(workDir, { recursive: true, force: true });
        }
    });

    async function cli(...args: string[]): Promise<string> {
        const { stdout } = await run("node", [cliBinary, ...args], { env: { ...process.env, PATH: toolPath } });
        return stdout;
    }

    it("--dry-run lists the mounted services and the files grpcurl collects, each after its imports", async () => {
        const output = await cli("proto", "sync", "--from", address, "--out", join(workDir, "unused"), "--dry-run");

        assert.deepStrictEqual(listedUnder(output, "Services:"), MOUNTED);

        // The CLI lists protobuf-es file names, which drop the ".proto" suffix
        // (documented for `fetchReflectionData().fileNames` in the CLI README);
        // grpcurl reports the descriptors' own names.
        const withoutSuffix = (name: string): string => name.replace(/\.proto$/, "");
        const files = listedUnder(output, "Files:");
        assert.deepStrictEqual([...files].sort(), grpcurlFiles.map((file) => withoutSuffix(file.name)).sort(), "the same files as grpcurl");
        assert.strictEqual(new Set(files).size, files.length, "no file twice");
        const byName = new Map(grpcurlFiles.map((file) => [withoutSuffix(file.name), file]));
        for (const [index, name] of files.entries()) {
            for (const dependency of byName.get(name)?.dependencies ?? []) {
                assert.ok(files.indexOf(withoutSuffix(dependency)) < index, `${name} is listed after its import ${dependency}`);
            }
        }
    });

    it("fetches the same descriptor bytes as grpcurl for every file", async () => {
        const fetched = readFileDescriptorSet(await fetchFileDescriptorSetBinary(`http://${address}`));
        const expected = new Map(grpcurlFiles.map((file) => [file.name, file.bytes]));
        assert.deepStrictEqual(fetched.map((file) => file.name).sort(), [...expected.keys()].sort());
        for (const file of fetched) {
            assert.ok(file.bytes.equals(expected.get(file.name) ?? Buffer.alloc(0)), `descriptor bytes of ${file.name} differ from what grpcurl received`);
        }
    });

    it("generates the same code from the server as buf generates from the sources", async () => {
        const template = join(workDir, "buf.gen.yaml");
        writeFileSync(template, ["version: v2", "plugins:", "  - local: protoc-gen-es", "    out: .", "    opt: target=ts", ""].join("\n"));

        const fromServer = join(workDir, "from-server");
        await cli("proto", "sync", "--from", address, "--out", fromServer, "--template", template);

        const image = join(workDir, "sources.binpb");
        const fromSources = join(workDir, "from-sources");
        const env = { ...process.env, PATH: toolPath };
        await run("buf", ["build", fixturesDir, "--exclude-source-info", "--output", image], { env });
        await run("buf", ["generate", image, "--template", template, "--output", fromSources], { env });

        const generated = listFiles(fromServer);
        for (const file of FIXTURE_FILES) {
            assert.ok(generated.includes(file), `proto sync generated ${file}`);
            assert.strictEqual(
                readFileSync(join(fromServer, file), "utf8"),
                readFileSync(join(fromSources, file), "utf8"),
                `${file} generated from the server equals the one generated from the sources`,
            );
        }
    });
});
