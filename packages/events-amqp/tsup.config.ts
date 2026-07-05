import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts", "src/testing.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    // Shared chunks are REQUIRED with the dual entry: without splitting each
    // bundle gets its own COPY of errors.ts, and `instanceof` breaks between
    // `@connectum/events-amqp` and the `/testing` subpath (the fake would
    // throw class objects different from the barrel's) — pinned by
    // tests/unit/dist-parity.test.ts.
    splitting: true,
    // Keep the node: prefix on builtin imports — required for node:test/sqlite and portable to Deno/Bun.
    removeNodeProtocol: false,
});
