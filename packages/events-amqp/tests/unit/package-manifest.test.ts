/**
 * Declared package contract: what `package.json` promises consumers about the
 * `amqplib` dependency and the `./testing` subpath.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

interface Manifest {
    readonly dependencies?: Record<string, string>;
    readonly exports?: Record<string, { readonly types?: string; readonly default?: string }>;
}

const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as Manifest;
const installed = JSON.parse(readFileSync(new URL("../../node_modules/amqplib/package.json", import.meta.url), "utf8")) as { readonly version: string };

function parseVersion(text: string): [number, number, number] {
    const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text);
    assert.ok(match, `not a plain x.y.z version: ${text}`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** `a` is at least `b`, comparing major, minor, patch in order. */
function atLeast(a: readonly number[], b: readonly number[]): boolean {
    for (let i = 0; i < 3; i += 1) {
        if ((a[i] as number) !== (b[i] as number)) {
            return (a[i] as number) > (b[i] as number);
        }
    }
    return true;
}

describe("the amqplib dependency", () => {
    // The adapter relies on amqplib 2.2.0's recovery: the `calculateDelay`
    // hook, `initialMaxRetries` and `waitForConnect`. The documented
    // dependency is `^2.2.0`; an earlier floor lets a consumer install a
    // release without them.
    const FLOOR = [2, 2, 0];

    it("is declared as a caret range whose lower bound is at least 2.2.0", () => {
        const range = manifest.dependencies?.amqplib;
        assert.ok(range, "amqplib is a runtime dependency");
        assert.match(range, /^\^\d+\.\d+\.\d+$/, "a caret range, so the lower bound is the stated version");
        assert.ok(atLeast(parseVersion(range.slice(1)), FLOOR), `lower bound ${range} is below 2.2.0`);
    });

    it("is installed at a version inside the declared range", () => {
        const range = manifest.dependencies?.amqplib ?? "";
        const lower = parseVersion(range.slice(1));
        const actual = parseVersion(installed.version);
        assert.ok(atLeast(actual, lower), `installed ${installed.version} is below ${range}`);
        assert.equal(actual[0], lower[0], `installed ${installed.version} is outside ${range}`);
    });
});

describe("the ./testing subpath in the exports map", () => {
    it("points the runtime and the types at the built testing entry", () => {
        assert.deepEqual(manifest.exports?.["./testing"], {
            types: "./dist/testing.d.ts",
            default: "./dist/testing.js",
        });
    });
});
