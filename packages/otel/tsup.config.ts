import { defineConfig } from "tsup";

export default defineConfig({
    entry: [
        "src/index.ts",
        "src/interceptor.ts",
        "src/client-interceptor.ts",
        "src/shared.ts",
        "src/tracer.ts",
        "src/meter.ts",
        "src/logger.ts",
        "src/traced.ts",
        "src/traceAll.ts",
        "src/attributes.ts",
        "src/metrics.ts",
        "src/provider.ts",
    ],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    splitting: false,
});
