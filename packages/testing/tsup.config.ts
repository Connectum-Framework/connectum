import { defineConfig } from "tsup";

export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm"],
    dts: true,
    sourcemap: true,
    clean: true,
    minify: false,
    splitting: false,
    async onSuccess() {
        // Restore `node:` prefix for `node:test` (esbuild strips it)
        const fs = await import("node:fs");
        const distPath = new URL("./dist/index.js", import.meta.url).pathname;
        let code = fs.readFileSync(distPath, "utf-8");
        code = code.replace(/from "test"/g, 'from "node:test"');
        fs.writeFileSync(distPath, code);
    },
});
