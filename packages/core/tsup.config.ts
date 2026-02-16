import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/types.ts", "src/config/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    splitting: false,
});
