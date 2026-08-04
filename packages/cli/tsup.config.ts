import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/commands/proto-sync.ts", "src/commands/init.ts", "src/commands/generate-service.ts", "src/utils/reflection.ts", "src/utils/emit.ts"],
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
