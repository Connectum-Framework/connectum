import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/types.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    // Several entries share modules. With splitting they import one shared chunk
    // instead of each inlining its own copy, so each module is evaluated once;
    // the release gate's module-identity check keeps it that way.
    splitting: true,
    // Keep the node: prefix on builtin imports — required for node:test/sqlite and portable to Deno/Bun.
    removeNodeProtocol: false,
});
