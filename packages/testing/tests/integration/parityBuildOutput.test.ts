/**
 * Build-output regression for the `./parity` subpath.
 *
 * tsup strips the `node:` prefix from builtin imports by default
 * (`removeNodeProtocol: true`). For `node:test` that is fatal — the unprefixed
 * `test` has no bare builtin equivalent, so the published `dist/parity.js`
 * shipped `import { test } from "test"` and threw `Cannot find package 'test'`
 * in every consumer. The fix is `removeNodeProtocol: false` in tsup.config.ts;
 * this guards the built artifact against the regression. (build → test in the
 * turbo graph guarantees dist exists when this runs.)
 */

import assert from "node:assert";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const parityJs = fileURLToPath(new URL("../../dist/parity.js", import.meta.url));

describe("parity build output — node: protocol preserved", () => {
    const src = readFileSync(parityJs, "utf8");

    it("imports node:test with its prefix (never bare 'test')", () => {
        assert.match(src, /from\s*"node:test"/, "expected `from \"node:test\"` in dist/parity.js");
        assert.doesNotMatch(src, /from\s*"test"/, "bare `from \"test\"` would be unresolvable for consumers");
    });

    it("keeps the node: prefix on other builtins (e.g. node:assert)", () => {
        assert.doesNotMatch(src, /from\s*"assert"/, "bare `from \"assert\"` indicates node: stripping is back on");
    });
});
