/**
 * Cross-transport parity entry point — isolated from `@connectum/testing`'s
 * main entry so consumers that do not need the `node:test` based parity
 * driver are not forced to load it.
 *
 * Reason: `transportParityTest` imports `node:test`, which esbuild
 * (used via tsup) strips the `node:` prefix from when bundling. The
 * resulting `import { test } from "test"` fails at runtime in every
 * consumer that does not happen to have a `test` package installed.
 * Keeping this surface in its own entry means the main bundle stays
 * runtime-safe for non-parity consumers.
 *
 * Re-exports:
 *   - {@link transportParityTest}, {@link defaultCompare} — the driver
 *   - {@link ParityScenarioContext}, {@link ParityScenarioResult},
 *     {@link TransportParityTestOptions}, {@link TransportKind}
 *
 * @module @connectum/testing/parity
 */

export {
    defaultCompare,
    type ParityScenarioContext,
    type ParityScenarioResult,
    type TransportKind,
    type TransportParityTestOptions,
    transportParityTest,
} from "./transportParityTest.ts";
