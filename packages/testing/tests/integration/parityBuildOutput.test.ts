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
import { builtinModules } from "node:module";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const parityJs = fileURLToPath(new URL("../../dist/parity.js", import.meta.url));

/** Module specifiers of every static `import ... from "x"` / `import "x"` in a built file, quote style aside. */
function importedSpecifiers(source: string): string[] {
    const specifiers: string[] = [];
    for (const match of source.matchAll(/(?:\bfrom|\bimport)\s*(["'])([^"']+)\1/g)) {
        specifiers.push(match[2] as string);
    }
    return specifiers;
}

describe("parity build output — node: protocol preserved", () => {
    const src = readFileSync(parityJs, "utf8");
    const specifiers = importedSpecifiers(src);

    it("imports node:test with its prefix (never bare 'test')", () => {
        assert.ok(specifiers.includes("node:test"), `expected an import of "node:test" in dist/parity.js, found: ${specifiers.join(", ")}`);
        assert.ok(!specifiers.includes("test"), 'bare import of "test" would be unresolvable for consumers');
    });

    it("keeps the node: prefix on other builtins (e.g. node:assert)", () => {
        assert.ok(specifiers.includes("node:assert"), `expected an import of "node:assert" in dist/parity.js, found: ${specifiers.join(", ")}`);
        const bareBuiltins = specifiers.filter((specifier) => !specifier.startsWith("node:") && builtinModules.includes(specifier));
        assert.deepStrictEqual(bareBuiltins, [], "a bare builtin specifier indicates node: stripping is back on");
    });
});
