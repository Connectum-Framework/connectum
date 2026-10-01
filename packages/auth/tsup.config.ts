import { defineConfig } from "tsup";

export default defineConfig({
    entry: {
        index: "src/index.ts",
        "testing/index": "src/testing/index.ts",
        "proto/index": "src/proto/index.ts",
        // The option descriptors behind the `./gen/connectum/auth/v1/options_pb.js` export,
        // which code generated with `map_imports` imports. A separate entry (not a copy of
        // gen/) so that, with splitting on, this file and `proto/index` import ONE shared
        // chunk: the package evaluates the descriptor once and both entries hand out the
        // same objects.
        "gen/connectum/auth/v1/options_pb": "gen/connectum/auth/v1/options_pb.js",
    },
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    // Enable code splitting so consumers can tree-shake and so testing/proto entry points
    // are emitted as separate chunks instead of being bundled into the main auth build.
    // Package consumers should expect multiple ESM output files/chunks from this config.
    splitting: true,
    // Keep the node: prefix on builtin imports — required for node:test/sqlite and portable to Deno/Bun.
    removeNodeProtocol: false,
});
