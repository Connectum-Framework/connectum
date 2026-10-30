---
"@connectum/protoc-gen-catalog": minor
---

feat: `protoc-gen-connectum-catalog` refuses a `target` other than `ts`. The README has always said the catalog is TypeScript only, but the standard `target` option of `@bufbuild/protoplugin` was accepted: `target=js` and `target=dts` wrote a transpiled `catalog.gen.js` (no `declare module "@connectum/core"` augmentation) or `catalog.gen.d.ts` (every service typed `any`), and a `buf.gen.yaml` without a `target` got both files and no `.ts`, so every `ctx.call` key was silently untyped. All of these now fail with `target "js+dts" is not supported: the catalog is TypeScript only ... Use opt: [target=ts]`, and nothing is written. Add `target=ts` to the plugin's `opt` in `buf.gen.yaml` (the Quick Start already does); if you imported `catalog.gen.js` or `catalog.gen.d.ts`, import `catalog.gen.ts` (or its `.js` specifier through `import_extension=.js`) instead.
