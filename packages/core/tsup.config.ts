import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/types.ts", "src/config/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    // Several entries share modules. Without splitting each entry inlines its own
    // copy, so `ServerState` from `@connectum/core` and from `@connectum/core/types`
    // would be two objects, and so would the config schemas. With splitting, every
    // entry imports one shared chunk; the release gate's module-identity check
    // keeps it that way.
    splitting: true,
    // Keep the node: prefix on builtin imports — required for node:test/sqlite and portable to Deno/Bun.
    removeNodeProtocol: false,
});
