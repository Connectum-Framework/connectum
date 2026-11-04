/**
 * The README of a scaffolded project must say what has to be configured or running before
 * `start` works. The variables and defaults it names are read back from the code the same
 * scaffold generates, and the broker images from the workflow that runs the adapters against them,
 * so the README cannot name a variable the project does not read or an image nobody has run.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { generateAuthFile } from "../../src/scaffold/authFragment.ts";
import { generateEventBusFile } from "../../src/scaffold/eventsFragment.ts";
import { generateReadme } from "../../src/scaffold/transform.ts";
import type { EventAdapter, ModuleSelection, ScaffoldConfig } from "../../src/scaffold/types.ts";

const config = (modules: ModuleSelection): ScaffoldConfig => ({ dir: "svc", name: "svc", runtime: "node", packageManager: "pnpm", nodeExec: "raw", sample: true, modules });

/** Every `process.env.NAME ?? "default"` (or without a default) read by a generated source file. */
function envReads(source: string): Array<{ name: string; fallback: string | undefined }> {
    return [...source.matchAll(/process\.env\.([A-Z0-9_]+)(?: \?\? "([^"]*)")?/g)].map((m) => ({ name: m[1] as string, fallback: m[2] }));
}

const ADAPTERS: readonly EventAdapter[] = ["nats", "kafka", "redpanda", "redis", "amqp"];
const ciWorkflow = readFileSync(fileURLToPath(new URL("../../../../.github/workflows/ci.yml", import.meta.url)), "utf8");

describe("generateReadme: what a module needs before start", () => {
    it("adds no section for a project without auth or events", () => {
        const readme = generateReadme(config({}));
        assert.doesNotMatch(readme, /JWKS_URI|## Authentication|## Events/);
    });

    describe("--auth", () => {
        const readme = generateReadme(config({ auth: true }));
        const reads = envReads(generateAuthFile({}));

        it("names every environment variable src/auth.ts reads, with its default", () => {
            assert.deepEqual(reads.map((r) => r.name).sort(), ["JWKS_URI", "JWT_AUDIENCE", "JWT_ISSUER"]);
            assert.match(readme, /^## Authentication$/m);
            for (const { name, fallback } of reads) {
                const line = readme.split("\n").find((l) => l.includes(`\`${name}\``));
                assert.ok(line !== undefined, `${name} is not described:\n${readme}`);
                if (fallback !== undefined) {
                    assert.ok(line.includes(`\`${fallback}\``), `the default ${fallback} of ${name} is not stated: ${line}`);
                }
            }
        });

        it("says which methods need a token and which stay open", () => {
            assert.ok(readme.includes("`SayHello`"), readme);
            assert.ok(readme.includes("`SayGoodbye`"), readme);
            assert.match(readme, /Health and reflection/);
        });
    });

    describe("--events", () => {
        for (const adapter of ADAPTERS) {
            it(`${adapter}: names the variable the event bus reads, its default and what must run`, () => {
                const readme = generateReadme(config({ events: { adapter } }));
                const reads = envReads(generateEventBusFile(config({ events: { adapter } }), adapter));

                assert.equal(reads.length, 1, "the event bus file reads exactly one address variable");
                const [{ name, fallback }] = reads as [{ name: string; fallback: string }];
                assert.match(readme, /^## Events$/m);
                const line = readme.split("\n").find((l) => l.includes(`\`${name}\``));
                assert.ok(line !== undefined, `${name} is not described:\n${readme}`);
                assert.ok(line.includes(`\`${fallback}\``), `the default ${fallback} is not stated: ${line}`);
                assert.match(readme, /connects to\s+the broker when the server starts/);
            });
        }

        // Only images the repository's own workflow runs the adapters against are offered, with the
        // exact tag; a broker that needs a configuration of its own gets no command.
        const commands: Array<[EventAdapter, RegExp]> = [
            // The NATS adapter uses JetStream, which the server enables only with -js (CI starts it that way too).
            ["nats", /^docker run --rm -p 4222:4222 (nats:\S+) -js$/m],
            ["redis", /^docker run --rm -p 6379:6379 (redis:\S+)$/m],
            ["amqp", /^docker run --rm -p 5672:5672 (rabbitmq:\S+)$/m],
        ];
        for (const [adapter, pattern] of commands) {
            it(`${adapter}: offers a docker command whose image the CI workflow runs`, () => {
                const image = pattern.exec(generateReadme(config({ events: { adapter } })))?.[1];
                assert.ok(image !== undefined, `no docker command for ${adapter}`);
                assert.ok(ciWorkflow.includes(`image: ${image}`), `${image} is not an image of .github/workflows/ci.yml`);
            });
        }

        for (const adapter of ["kafka", "redpanda"] as const) {
            it(`${adapter}: offers no docker command, which would need a broker configuration of its own`, () => {
                assert.doesNotMatch(generateReadme(config({ events: { adapter } })), /docker run/);
            });
        }
    });

    it("lists the sections of the enabled modules in one README, after the next steps", () => {
        const readme = generateReadme(config({ auth: true, events: { adapter: "nats" } }));
        assert.ok(readme.indexOf("## Next steps") < readme.indexOf("## Authentication"));
        assert.ok(readme.indexOf("## Authentication") < readme.indexOf("## Events"));
    });
});
