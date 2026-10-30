/**
 * `--no-healthcheck`: nothing the project generates may depend on the health endpoint. The server
 * wiring drops the protocol (covered with the server generator); what is left to check is the
 * base's own files that probe it, the container `HEALTHCHECK` and the dependency on the package.
 * The Dockerfiles are copies of the ones in the pinned base (see `tests/fixtures/base-v1.3.1`),
 * not hand-made approximations, so the removal is judged on the text it really meets.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { executeInit } from "../../src/commands/init.ts";
import { removeContainerHealthcheck } from "../../src/scaffold/healthcheckFragment.ts";
import { transformBase } from "../../src/scaffold/transform.ts";
import type { ScaffoldConfig } from "../../src/scaffold/types.ts";
import { baseFiles, cloneOf } from "../helpers/baseFixture.ts";

const fixture = (name: string): string => readFileSync(fileURLToPath(new URL(`../fixtures/base-v1.3.1/${name}`, import.meta.url)), "utf8");
const DOCKERFILE = fixture("Dockerfile");
const DOCKERFILE_BUN = fixture("Dockerfile.bun");

/** The runtime stage of the base Dockerfile, with the health probe and the curl it needs removed, written out by hand. */
const NODE_RUNTIME_WITHOUT_PROBE = `# ── runtime ─────────────────────────────────────────────────────────────────
FROM node:25-slim AS runtime
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/gen ./gen
COPY package.json ./
COPY src/ ./src/
ENV NODE_ENV=production PORT=5000
EXPOSE 5000
# Run as the built-in non-root \`node\` user.
USER node
CMD ["node", "src/index.ts"]
`;

const config = (healthcheck: boolean | undefined): ScaffoldConfig => ({
    dir: "svc",
    name: "svc",
    runtime: "node",
    packageManager: "pnpm",
    nodeExec: "raw",
    sample: true,
    modules: healthcheck === undefined ? {} : { healthcheck },
});

function withDockerfiles(): Map<string, string> {
    const files = baseFiles();
    files.set("Dockerfile", DOCKERFILE);
    files.set("Dockerfile.bun", DOCKERFILE_BUN);
    const manifest = JSON.parse(files.get("package.json") ?? "{}") as { dependencies: Record<string, string> };
    manifest.dependencies = { "@connectum/core": "^1.0.0", "@connectum/healthcheck": "^1.0.0", "@connectum/reflection": "^1.0.0" };
    files.set("package.json", JSON.stringify(manifest));
    return files;
}

describe("removeContainerHealthcheck", () => {
    it("removes the HEALTHCHECK, the curl install made for it and the comments above both, and nothing else", () => {
        const out = removeContainerHealthcheck(DOCKERFILE);

        assert.ok(out.endsWith(NODE_RUNTIME_WITHOUT_PROBE), out.slice(out.indexOf("# ── runtime")));
        // Everything before the runtime stage is the base, untouched.
        assert.equal(out.slice(0, out.length - NODE_RUNTIME_WITHOUT_PROBE.length), DOCKERFILE.slice(0, DOCKERFILE.indexOf("# ── runtime")));
    });

    it("does the same for the Bun Dockerfile", () => {
        const out = removeContainerHealthcheck(DOCKERFILE_BUN);

        assert.doesNotMatch(out, /HEALTHCHECK|healthz|curl/i);
        assert.match(out, /USER bun\nCMD \["bun", "run", "src\/index\.ts"\]\n$/);
        assert.match(out, /FROM oven\/bun:1-slim AS runtime\nWORKDIR \/app\n/);
    });

    it("leaves a Dockerfile without a HEALTHCHECK as it is", () => {
        const plain = "FROM node:25-slim\nUSER node\nCMD [\"node\", \"src/index.ts\"]\n";
        assert.equal(removeContainerHealthcheck(plain), plain);
    });

    it("keeps an install line that adds more than curl, and removes the HEALTHCHECK", () => {
        const dockerfile = "FROM node:25-slim\nRUN apt-get update && apt-get install -y --no-install-recommends curl tini && rm -rf /var/lib/apt/lists/*\nHEALTHCHECK CMD curl -f http://localhost:5000/healthz\nUSER node\n";
        assert.equal(removeContainerHealthcheck(dockerfile), "FROM node:25-slim\nRUN apt-get update && apt-get install -y --no-install-recommends curl tini && rm -rf /var/lib/apt/lists/*\nUSER node\n");
    });

    it("fails loudly when a HEALTHCHECK is left that the scan did not remove, rather than emit an unhealthy container", () => {
        const twoStages = "FROM a AS one\nHEALTHCHECK CMD true\nFROM b AS two\nHEALTHCHECK CMD true\n";
        assert.throws(() => removeContainerHealthcheck(twoStages), /could not remove the container HEALTHCHECK.*drifted/s);
    });
});

describe("transformBase with --no-healthcheck", () => {
    it("drops the container HEALTHCHECK from both Dockerfiles and the dependency on the health package", () => {
        const out = transformBase(withDockerfiles(), config(false));

        for (const name of ["Dockerfile", "Dockerfile.bun"]) {
            assert.doesNotMatch(out.get(name) ?? "", /HEALTHCHECK|healthz/i, name);
        }
        const pkg = JSON.parse(out.get("package.json") ?? "{}") as { dependencies: Record<string, string> };
        assert.equal("@connectum/healthcheck" in pkg.dependencies, false, JSON.stringify(pkg.dependencies));
        // The other base dependencies stay.
        assert.equal(pkg.dependencies["@connectum/reflection"] !== undefined, true);
        assert.equal(pkg.dependencies["@connectum/core"] !== undefined, true);
    });

    for (const [label, healthcheck] of [
        ["by default", undefined],
        ["with --healthcheck", true],
    ] as const) {
        it(`keeps the Dockerfiles and the dependency exactly as the base has them ${label}`, () => {
            const out = transformBase(withDockerfiles(), config(healthcheck));

            assert.equal(out.get("Dockerfile"), DOCKERFILE);
            assert.equal(out.get("Dockerfile.bun"), DOCKERFILE_BUN);
            const pkg = JSON.parse(out.get("package.json") ?? "{}") as { dependencies: Record<string, string> };
            assert.equal(pkg.dependencies["@connectum/healthcheck"], "^1.0.0");
        });
    }

    it("leaves no mention of the health endpoint in the generated project when the module is off", () => {
        const out = transformBase(withDockerfiles(), { ...config(false), modules: { healthcheck: false, reflection: false } });

        for (const [path, content] of out) {
            // The README may explain the option; no file that runs or builds the project may use the endpoint.
            if (path === "README.md") continue;
            assert.doesNotMatch(content, /healthz|HEALTHCHECK|@connectum\/healthcheck/, path);
        }
    });
});

describe("init --no-healthcheck end to end (injected clone)", () => {
    let workdir: string;
    let previous: string;

    beforeEach(() => {
        previous = process.cwd();
        workdir = mkdtempSync(join(tmpdir(), "connectum-nohealth-"));
        process.chdir(workdir);
    });
    afterEach(() => {
        process.chdir(previous);
        rmSync(workdir, { recursive: true, force: true });
    });

    it("writes Dockerfiles with no HEALTHCHECK and a manifest without the health package", async () => {
        const clone = cloneOf((files) => {
            for (const [path, content] of withDockerfiles()) {
                files.set(path, content);
            }
        });

        await executeInit({ name: "demo", healthcheck: false, yes: true, clone });

        assert.doesNotMatch(readFileSync(join(workdir, "demo/Dockerfile"), "utf8"), /HEALTHCHECK/);
        assert.doesNotMatch(readFileSync(join(workdir, "demo/Dockerfile.bun"), "utf8"), /HEALTHCHECK/);
        assert.doesNotMatch(readFileSync(join(workdir, "demo/package.json"), "utf8"), /@connectum\/healthcheck/);
        assert.doesNotMatch(readFileSync(join(workdir, "demo/src/server.ts"), "utf8"), /Healthcheck/);
    });
});
