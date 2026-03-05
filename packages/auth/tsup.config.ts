import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/testing/index.ts", "src/proto/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    // Enable code splitting so consumers can tree-shake and so testing/proto entry points
    // are emitted as separate chunks instead of being bundled into the main auth build.
    // Package consumers should expect multiple ESM output files/chunks from this config.
    splitting: true,
});
