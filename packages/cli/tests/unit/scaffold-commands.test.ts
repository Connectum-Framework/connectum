/**
 * Tests for the scaffolding command seam.
 *
 * `init` runs the real fetch→transform→emit pipeline against an injected local
 * clone stub (no network). `generate service` emits a starter proto plus a
 * `defineService` skeleton, and these lock its input validation and output shape.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { executeGenerateService, generateServiceCommand } from "../../src/commands/generate-service.ts";
import { executeInit, initCommand } from "../../src/commands/init.ts";
import type { CloneFn } from "../../src/scaffold/fetchBase.ts";
import { DEFAULT_BASE_REF } from "../../src/scaffold/fetchBase.ts";
import { cloneOf, cloneStub } from "../helpers/baseFixture.ts";

describe("init command", () => {
    it("exports a citty command with a run handler", () => {
        assert.equal(typeof initCommand.run, "function");
    });
});

describe("executeInit pipeline (injected clone, no network)", () => {
    let workdir: string;
    let cwd: string;

    beforeEach(() => {
        cwd = process.cwd();
        workdir = mkdtempSync(join(tmpdir(), "connectum-init-work-"));
        process.chdir(workdir);
    });

    afterEach(() => {
        process.chdir(cwd);
        rmSync(workdir, { recursive: true, force: true });
    });

    it("scaffolds a project from the base", async () => {
        await executeInit({ name: "myservice", clone: cloneStub });
        const pkg = JSON.parse(readFileSync(join(workdir, "myservice/package.json"), "utf8"));
        assert.equal(pkg.name, "myservice");
        assert.equal(pkg.private, undefined);
        // pnpm (default) gets a standalone pnpm-workspace.yaml with the buf build-approval.
        assert.match(readFileSync(join(workdir, "myservice/pnpm-workspace.yaml"), "utf8"), /allowBuilds:/);
        assert.match(readFileSync(join(workdir, "myservice/tests/e2e/e2e.test.ts"), "utf8"), /createLocalClient/);
        assert.equal(pkg.devDependencies["@connectum/testing"], "^1.0.0");
    });

    it("creates the project at the typed path and names the package after its last segment", async () => {
        await executeInit({ name: "apps/payments", clone: cloneStub });
        const pkg = JSON.parse(readFileSync(join(workdir, "apps/payments/package.json"), "utf8"));
        assert.equal(pkg.name, "payments");
    });

    it("refuses an invalid package name without touching the disk", async () => {
        for (const name of ["My-App", "my app", "a${b}c", "node:fs"]) {
            await assert.rejects(() => executeInit({ name, clone: cloneStub }), /invalid project name/);
        }
        assert.deepEqual(readdirSync(workdir), []);
    });

    it("refuses --no-sample with --auth before fetching the base", async () => {
        let fetched = false;
        const spy: CloneFn = async (source, dest) => {
            fetched = true;
            await cloneStub(source, dest);
        };
        await assert.rejects(() => executeInit({ name: "demo", sample: false, auth: true, clone: spy }), /--no-sample cannot be combined with --auth/);
        assert.equal(fetched, false);
        assert.deepEqual(readdirSync(workdir), []);
    });

    it("reports every defect of an unfit base in one message and writes nothing", async () => {
        const unfit = cloneOf((files) => {
            files.delete("tsconfig.json");
            files.delete("proto/greeter/v1/greeter.proto");
        });
        await assert.rejects(
            () => executeInit({ name: "demo", clone: unfit }),
            (err: Error) => /cannot be used/.test(err.message) && /tsconfig\.json/.test(err.message) && /greeter\.proto/.test(err.message),
        );
        assert.deepEqual(readdirSync(workdir), []);
    });

    it("scaffolds a base without the Greeter files when --no-sample is given", async () => {
        const noGreeter = cloneOf((files) => {
            files.delete("proto/greeter/v1/greeter.proto");
            files.delete("src/services/greeterService.ts");
        });
        await executeInit({ name: "demo", sample: false, clone: noGreeter });
        assert.equal(existsSync(join(workdir, "demo/proto/greeter")), false);
        assert.match(readFileSync(join(workdir, "demo/tests/e2e/server.test.ts"), "utf8"), /buildServer\(0\)/);
        assert.match(readFileSync(join(workdir, "demo/src/server.ts"), "utf8"), /services: \[\],/);
    });

    it("refuses to clobber a non-empty target directory", async () => {
        mkdirSync(join(workdir, "taken"), { recursive: true });
        writeFileSync(join(workdir, "taken/package.json"), "{}");
        await assert.rejects(() => executeInit({ name: "taken", clone: cloneStub }), /already exists and is not empty/);
    });

    it("rejects an invalid runtime before doing any work", async () => {
        await assert.rejects(() => executeInit({ name: "x", runtime: "deno", clone: cloneStub }), /invalid --runtime/);
    });

    it("fails clearly when the target path exists as a file (not a raw ENOTDIR)", async () => {
        writeFileSync(join(workdir, "afile"), "x");
        await assert.rejects(() => executeInit({ name: "afile", clone: cloneStub }), /is not a directory/);
    });

    it("fetches a pinned tag by default, not a moving branch", async () => {
        // A published CLI is immutable but its base is not: the module fragments
        // transform the fetched text, so a moving default ref would let an edit on
        // examples/main break `init` for every already-released CLI version.
        assert.notEqual(DEFAULT_BASE_REF, "main");
        assert.match(DEFAULT_BASE_REF, /^v\d+\.\d+\.\d+$/);

        const seen: string[] = [];
        const recordingClone: CloneFn = async (source, dest) => {
            seen.push(source);
            await cloneStub(source, dest);
        };
        await executeInit({ name: "pinned", clone: recordingClone });
        // `gh:` is giget's provider prefix; without it the spec reads as a local path.
        assert.deepStrictEqual(seen, [`gh:Connectum-Framework/examples/getting-started#${DEFAULT_BASE_REF}`]);
    });

    it("honours an explicit --ref override", async () => {
        const seen: string[] = [];
        const recordingClone: CloneFn = async (source, dest) => {
            seen.push(source);
            await cloneStub(source, dest);
        };
        await executeInit({ name: "overridden", clone: recordingClone, ref: "main" });
        assert.deepStrictEqual(seen, ["gh:Connectum-Framework/examples/getting-started#main"]);
    });
});

/** A generated module without comment lines and with whitespace collapsed, so checks do not depend on layout. */
function codeOf(source: string): string {
    return source
        .replace(/^\s*\/\/.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim();
}

/** The rpc method names declared by `service <service> { ... }` in a proto file, in order. */
function rpcMethods(proto: string, service: string): string[] {
    const body = proto.match(new RegExp(`^service ${service} \\{\\n([\\s\\S]*?)\\n\\}$`, "m"))?.[1];
    assert.ok(body !== undefined, `service ${service} is not declared in:\n${proto}`);
    return [...body.matchAll(/\brpc (\w+)\(/g)].map((m) => m[1] as string);
}

describe("executeGenerateService", () => {
    let dir: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "connectum-gensvc-"));
    });
    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it("exports a citty command with a run handler", () => {
        assert.equal(typeof generateServiceCommand.run, "function");
    });

    // A handler that is generated for fewer rpc methods than the proto declares leaves the others
    // to fail at runtime without a trace, so the check is derived from the generated proto: every
    // rpc it declares must own exactly one throwing handler, keyed by the camelCase method name.
    it("answers Unimplemented from one handler per rpc the generated proto declares", async () => {
        await executeGenerateService({ name: "billing", cwd: dir });
        const proto = readFileSync(join(dir, "proto/billing/v1/billing.proto"), "utf8");
        assert.match(proto, /^package billing\.v1;$/m);
        const methods = rpcMethods(proto, "BillingService");
        assert.deepEqual(methods, ["Ping"]);

        const impl = readFileSync(join(dir, "src/services/billingService.ts"), "utf8");
        const source = codeOf(impl);
        assert.ok(source.includes('import { defineService } from "@connectum/core";'), source);
        assert.ok(source.includes('import { Code, ConnectError } from "@connectrpc/connect";'), source);
        assert.ok(source.includes('import { BillingService } from "#gen/billing/v1/billing_pb.ts";'), source);
        assert.match(source, /export const billingService = defineService\(BillingService, \{/);
        for (const method of methods) {
            const key = method.charAt(0).toLowerCase() + method.slice(1);
            assert.ok(
                source.includes(`${key}: (_req, _ctx) => { throw new ConnectError("${method} not implemented", Code.Unimplemented); },`),
                `no throwing handler for ${method}: ${source}`,
            );
        }
        assert.equal(source.match(/throw new ConnectError\(/g)?.length, methods.length);
    });

    it("with --with-events emits the event-handler proto, the vendored option proto and acknowledging handlers", async () => {
        await executeGenerateService({ name: "orders", withEvents: true, cwd: dir });
        const proto = readFileSync(join(dir, "proto/orders/v1/orders.proto"), "utf8");
        const source = codeOf(readFileSync(join(dir, "src/services/ordersService.ts"), "utf8"));

        // The event proto: the option proto and Empty are imported, the handler service declares
        // the handler rpc returning Empty and annotates it with the subscription topic.
        assert.match(proto, /^import "connectum\/events\/v1\/options\.proto";$/m);
        assert.match(proto, /^import "google\/protobuf\/empty\.proto";$/m);
        assert.deepEqual(rpcMethods(proto, "OrdersEventHandlers"), ["OnOrdersEvent"]);
        assert.match(proto, /rpc OnOrdersEvent\(OrdersEvent\) returns \(google\.protobuf\.Empty\) \{\s*option \(connectum\.events\.v1\.event\)\.topic = "[^"]+";\s*\}/);
        const optionProto = readFileSync(join(dir, "proto/connectum/events/v1/options.proto"), "utf8");
        assert.match(optionProto, /^package connectum\.events\.v1;$/m);

        // The event handler: registered through events.service for every handler rpc, ends with
        // `await ctx.ack()` and never throws (a throw would start retry and dead-letter delivery).
        const route = source.match(/events\.service\(OrdersEventHandlers, \{(.*)\}\);/)?.[1];
        assert.ok(route !== undefined, source);
        assert.match(route, /^ async onOrdersEvent\(event, ctx\) \{/);
        assert.match(route, /await ctx\.ack\(\); \},? ?$/, route);
        assert.ok(!route.includes("throw"), route);
        assert.equal(route.match(/async on\w+\(/g)?.length, 1);
        // The unary skeleton in the same module still answers Unimplemented.
        assert.ok(source.includes('throw new ConnectError("Ping not implemented", Code.Unimplemented);'), source);
    });

    it("rejects a service name that starts with a digit", async () => {
        // "123-orders" normalizes to "123orders": a proto package must start with a
        // letter, and the derived TS binding `123OrdersService` would not even parse.
        for (const name of ["123", "123-orders", "0a"]) {
            await assert.rejects(() => executeGenerateService({ name, cwd: dir }), /must start with a letter/);
        }
    });

    it("rejects a service name with no alphanumeric characters", async () => {
        await assert.rejects(() => executeGenerateService({ name: "!!!", cwd: dir }), /must start with a letter/);
    });

    it("requires a service name and writes nothing without one", async () => {
        await assert.rejects(() => executeGenerateService({ name: "  ", cwd: dir }), /service name is required/);
        assert.deepEqual(readdirSync(dir), []);
    });
});

describe("executeGenerateService: registration hint and existing files", () => {
    let dir: string;
    let printed: string[];

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "connectum-gensvc-hint-"));
        printed = [];
        mock.method(console, "log", (...args: unknown[]) => {
            printed.push(args.join(" "));
        });
    });
    afterEach(() => {
        mock.restoreAll();
        rmSync(dir, { recursive: true, force: true });
    });

    it("leaves src/server.ts byte-for-byte untouched and prints the registration to add by hand", async () => {
        const server = Buffer.from('// owned by the user\r\nimport { createServer } from "@connectum/core";\n\u0000tail without newline');
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src/server.ts"), server);

        await executeGenerateService({ name: "billing", cwd: dir });

        assert.deepEqual(readFileSync(join(dir, "src/server.ts")), server);
        // The hint is the documented block, verbatim.
        assert.ok(
            printed.join("\n").includes(
                [
                    "Register the new service in src/server.ts:",
                    '  import { billingService } from "#services/billingService.ts";',
                    "  // add billingService to the services: [...] array passed to createServer",
                ].join("\n"),
            ),
            printed.join("\n"),
        );
    });

    it("does not create src/server.ts when the project has none", async () => {
        await executeGenerateService({ name: "billing", cwd: dir });
        assert.equal(existsSync(join(dir, "src/server.ts")), false);
    });

    it("names the imported binding after the file the command actually wrote", async () => {
        await executeGenerateService({ name: "billing", cwd: dir });
        assert.match(readFileSync(join(dir, "src/services/billingService.ts"), "utf8"), /export const billingService\b/);
    });

    it("with --with-events also prints the event-route registration, and that route is exported by the generated file", async () => {
        await executeGenerateService({ name: "billing", withEvents: true, cwd: dir });

        const out = printed.join("\n");
        assert.ok(out.includes('  import { billingService } from "#services/billingService.ts";'), out);
        assert.ok(out.includes('  import { billingEventRoutes } from "#services/billingService.ts";'), out);
        assert.match(readFileSync(join(dir, "src/services/billingService.ts"), "utf8"), /export const billingEventRoutes\b/);
    });

    it("prints no event-route registration without --with-events", async () => {
        await executeGenerateService({ name: "billing", cwd: dir });
        assert.ok(!printed.join("\n").includes("billingEventRoutes"));
    });

    it("keeps an existing file's content on a repeat run without --force and reports it as skipped", async () => {
        await executeGenerateService({ name: "billing", cwd: dir });
        const impl = join(dir, "src/services/billingService.ts");
        writeFileSync(impl, "// hand-written implementation\n");
        printed.length = 0;

        await executeGenerateService({ name: "billing", cwd: dir });

        assert.equal(readFileSync(impl, "utf8"), "// hand-written implementation\n");
        const out = printed.join("\n");
        assert.match(out, /Skipped 2 existing file\(s\): .*src\/services\/billingService\.ts/);
        assert.match(out, /Generated 0 file\(s\)/);
    });

    it("overwrites existing files with --force and reports nothing as skipped", async () => {
        await executeGenerateService({ name: "billing", cwd: dir });
        const impl = join(dir, "src/services/billingService.ts");
        const generated = readFileSync(impl, "utf8");
        writeFileSync(impl, "// hand-written implementation\n");
        printed.length = 0;

        await executeGenerateService({ name: "billing", cwd: dir, force: true });

        assert.equal(readFileSync(impl, "utf8"), generated);
        const out = printed.join("\n");
        assert.match(out, /Generated 2 file\(s\)/);
        assert.ok(!out.includes("Skipped"), out);
    });
});
