import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/plugin.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    splitting: false,
    // Keep the node: prefix on builtin imports — required for node:test/sqlite and portable to Deno/Bun.
    removeNodeProtocol: false,
    banner: { js: "#!/usr/bin/env node" },
});
