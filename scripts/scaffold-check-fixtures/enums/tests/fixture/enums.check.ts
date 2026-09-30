/**
 * Scaffold-check fixture: proves that enums generated inside a `connectum init` project
 * are erasable. Copied into the scaffolded project after `init`, next to `enums.proto`.
 *
 * It is checked twice, and each pass catches a different regression:
 * - `typecheck` compiles it under the project's own `erasableSyntaxOnly` tsconfig, so a
 *   generated TypeScript `enum` fails with TS1294, and the `@ts-expect-error` below fails
 *   if the generated object ever regains a reverse mapping;
 * - the scaffold check then runs it with plain `node` (native type stripping, no loader),
 *   so a generated `enum` fails with ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX.
 *
 * The runtime assertions are chosen to differ between a TypeScript `enum` and an
 * `as const` object: a numeric enum also carries numeric reverse keys, so a runtime that
 * transpiles enums (Bun, tsx) would fail the key-list assertions instead of passing
 * vacuously.
 *
 * Named `*.check.ts`, not `*.test.ts`, so the project's `test` script does not pick it up:
 * the scaffold check runs it explicitly.
 */

import assert from "node:assert/strict";
import type { UnknownEnum } from "@bufbuild/protobuf";
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { Color, Paint_Finish, PaintSchema } from "#gen/fixture/v1/enums_pb.ts";

// Values keep their literal types: a single value's type is `typeof Color.RED`.
const red: typeof Color.RED = Color.RED;
const one: 1 = red;
// An open (proto3) enum's type also admits values the schema does not declare.
const unknownColor: Color = 99 as UnknownEnum;

assert.equal(one, 1);
assert.equal(Paint_Finish.GLOSS, 2);
assert.equal(unknownColor, 99);

// Only the declared value names, no numeric reverse keys.
assert.deepEqual(Object.keys(Color), ["UNSPECIFIED", "RED", "GREEN"]);
assert.deepEqual(Object.keys(Paint_Finish), ["UNSPECIFIED", "MATTE", "GLOSS"]);

// @ts-expect-error -- erasable enums have no reverse mapping from number to name.
const reverse = Color[1];
assert.equal(reverse, undefined);

// The enum values round-trip through the binary wire format.
const paint = fromBinary(PaintSchema, toBinary(PaintSchema, create(PaintSchema, { color: Color.GREEN, finish: Paint_Finish.GLOSS })));
assert.equal(paint.color, Color.GREEN);
assert.equal(paint.finish, Paint_Finish.GLOSS);

console.log("enum fixture: erasable enums type-check and load under native type stripping");
