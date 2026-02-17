import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/commands/proto-sync.ts", "src/utils/reflection.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    splitting: false,
    banner: { js: "#!/usr/bin/env node" },
});
