/**
 * Declared dependencies of the two packages that speak gRPC Server Reflection as a client.
 *
 * Connectum 1.2 and earlier used `@lambdalisue/connectrpc-grpcreflect` for the client side. The
 * packages now carry their own implementation, and the third-party client must not come back as a
 * dependency of any kind: a consumer that installs `@connectum/cli` or `@connectum/reflection` would
 * get its dependency tree, which brings a second copy of the protobuf runtime.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

interface Manifest {
    readonly name?: string;
    readonly dependencies?: Record<string, string>;
    readonly peerDependencies?: Record<string, string>;
    readonly optionalDependencies?: Record<string, string>;
}

const THIRD_PARTY_CLIENT = "@lambdalisue/connectrpc-grpcreflect";

const manifests: ReadonlyArray<readonly [string, Manifest]> = [
    ["@connectum/cli", JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as Manifest],
    ["@connectum/reflection", JSON.parse(readFileSync(new URL("../../../reflection/package.json", import.meta.url), "utf8")) as Manifest],
];

describe("reflection client dependency", () => {
    for (const [name, manifest] of manifests) {
        it(`${name} declares the package it replaced in no dependency field`, () => {
            assert.equal(manifest.name, name, "the manifest read is the one of the package under test");
            for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
                assert.equal(Object.hasOwn(manifest[field] ?? {}, THIRD_PARTY_CLIENT), false, `${name} must not list ${THIRD_PARTY_CLIENT} in ${field}`);
            }
        });
    }
});
