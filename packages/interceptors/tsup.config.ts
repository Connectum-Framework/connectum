import { defineConfig } from "tsup";

export default defineConfig({
    entry: [
        "src/index.ts",
        "src/errorHandler.ts",
        "src/serializer.ts",
        "src/logger.ts",
        "src/retry.ts",
        "src/circuit-breaker.ts",
        "src/timeout.ts",
        "src/bulkhead.ts",
        "src/fallback.ts",
        "src/defaults.ts",
        "src/method-filter.ts",
    ],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    // Several entries share modules. Without splitting each entry inlines its own
    // copy, so a factory imported from `@connectum/interceptors` and from its
    // subpath would be two different functions over two copies of any module
    // state. With splitting, every entry imports one shared chunk; the release
    // gate's module-identity check keeps it that way.
    splitting: true,
    // Keep the node: prefix on builtin imports — required for node:test/sqlite and portable to Deno/Bun.
    removeNodeProtocol: false,
});
