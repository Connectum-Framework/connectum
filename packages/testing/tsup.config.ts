import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/parity.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    splitting: false,
    // tsup strips the `node:` prefix from builtin imports by default
    // (removeNodeProtocol: true). For `node:test` that is fatal: the unprefixed
    // `test` has no bare builtin equivalent, so `dist/parity.js` shipped
    // `import { test } from "test"` and threw `Cannot find package 'test'` in
    // every consumer. The consumer floor is Node >=22.13 where the `node:`
    // prefix is required for node:test and supported for every builtin, so keep it.
    removeNodeProtocol: false,
});
