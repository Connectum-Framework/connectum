import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        // The option descriptors behind the `./gen/connectum/events/v1/options_pb.js`
        // export, which code generated with `map_imports` imports.
        "gen/connectum/events/v1/options_pb": "gen/connectum/events/v1/options_pb.js",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    // Splitting is what makes the two entries share the descriptor: without it each
    // entry inlines its own copy of the generated module, so the package would evaluate
    // the option proto twice and the export would hand out objects the package's own
    // runtime never uses. With it, both import one shared chunk.
    splitting: true,
    // Keep the node: prefix on builtin imports — required for node:test/sqlite and portable to Deno/Bun.
    removeNodeProtocol: false,
});
