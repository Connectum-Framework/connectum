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
    // Several entries share modules. Without splitting each entry inlines its own
    // copy, so the package holds one provider singleton per subpath: getProvider()
    // from `@connectum/otel` and from `@connectum/otel/provider` would be different
    // providers fighting over OpenTelemetry's global registration. With splitting,
    // every entry imports one shared chunk. The release gate's module-identity
    // check fails if a shared export ever differs between subpaths again.
    splitting: true,
    // Keep the node: prefix on builtin imports — required for node:test/sqlite and portable to Deno/Bun.
    removeNodeProtocol: false,
});
