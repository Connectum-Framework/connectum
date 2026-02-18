import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/testing/index.ts", "src/proto/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    splitting: true,
});
