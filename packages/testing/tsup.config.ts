import type { Options } from "tsup";
import { defineConfig } from "tsup";

/**
 * Post-build plugin that restores `node:` protocol prefix stripped by esbuild.
 *
 * esbuild strips `node:` from built-in imports (e.g., `node:test` becomes `test`).
 * This is fine for legacy built-ins like `fs`, `path`, etc., but `node:test` is only
 * available with the `node:` prefix in Node.js >=18. This plugin patches the output.
 */
function restoreNodeProtocol(): NonNullable<Options["plugins"]>[number] {
    return {
        name: "restore-node-protocol",
        buildEnd() {
            // Intentionally empty -- handled via esbuildOptions
        },
    };
}

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    splitting: false,
    async onSuccess() {
        // Restore `node:` prefix for `node:test` (esbuild strips it)
        const fs = await import("node:fs");
        const distPath = new URL("./dist/index.js", import.meta.url).pathname;
        let code = fs.readFileSync(distPath, "utf-8");
        code = code.replace(/from "test"/g, 'from "node:test"');
        fs.writeFileSync(distPath, code);
    },
});
