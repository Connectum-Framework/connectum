/**
 * Catalog shape and resolver options are checked wherever they are accepted.
 *
 * Only `defineCatalog()` used to check that a catalog key equals its
 * descriptor's type name. A hand-built map with a wrong key, a catalog client
 * without a resolver and `dnsResolver({})` were accepted and showed up later as
 * calls that go nowhere.
 */

import assert from "node:assert";
import { describe, it } from "node:test";
import { create } from "@bufbuild/protobuf";
import { createCatalogClient } from "../../src/catalogClient.ts";
import { CatalogConfigError } from "../../src/catalogErrors.ts";
import { defineService } from "../../src/defineService.ts";
import { dnsResolver, mapResolver, perServiceEnvResolver } from "../../src/remoteResolver.ts";
import { createServer } from "../../src/Server.ts";
import { defineCatalog } from "../../src/serviceCatalog.ts";
import { EchoResponseSchema, EchoService } from "../fixtures/echo/v1/echo_pb.ts";
import { StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

const echo = () =>
    defineService(EchoService, {
        echo: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
        secureEcho: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
        rateLimitedEcho: () => create(EchoResponseSchema, { message: "", timestamp: 0n }),
    });

const validCatalog = () => defineCatalog({ [EchoService.typeName]: EchoService });

function configError(pattern: RegExp) {
    return (error: unknown) => {
        assert.ok(error instanceof CatalogConfigError, `expected CatalogConfigError, got ${String(error)}`);
        assert.match(error.message, pattern);
        return true;
    };
}

describe("createServer({ catalog })", () => {
    it("rejects a key that differs from the descriptor typeName, with the defineCatalog message form", () => {
        assert.throws(() => createServer({ services: [echo()], catalog: { wrong: EchoService } }), configError(/createServer: key "wrong" must match descriptor\.typeName "echo\.v1\.EchoService"/));
    });

    it("rejects a catalog that is not an object", () => {
        assert.throws(() => createServer({ services: [echo()], catalog: "catalog" as never }), configError(/createServer: catalog must be an object/));
    });

    it("rejects an entry that is not a service descriptor", () => {
        assert.throws(() => createServer({ services: [echo()], catalog: { "a.v1.S": {} as never } }), configError(/a\.v1\.S/));
    });

    it("accepts a hand-built catalog whose keys are right, and defineCatalog output", () => {
        createServer({ services: [echo()], catalog: { [EchoService.typeName]: EchoService } });
        createServer({ services: [echo()], catalog: validCatalog() });
        createServer({ services: [echo()] });
    });
});

describe("createCatalogClient", () => {
    it("rejects a wrong catalog key", () => {
        assert.throws(() => createCatalogClient({ catalog: { wrong: EchoService }, resolver: () => null }), configError(/createCatalogClient: key "wrong" must match/));
    });

    it("rejects a missing resolver, naming the option", () => {
        assert.throws(() => createCatalogClient({ catalog: validCatalog() } as never), configError(/createCatalogClient: resolver must be a function/));
    });

    it("rejects a resolver that is not a function", () => {
        assert.throws(() => createCatalogClient({ catalog: validCatalog(), resolver: {} as never }), configError(/resolver must be a function/));
    });

    it("accepts a valid configuration", () => {
        createCatalogClient({ catalog: validCatalog(), resolver: () => null });
    });
});

describe("resolver factories", () => {
    it("dnsResolver rejects missing, empty and non-string templates", () => {
        assert.throws(() => dnsResolver({} as never), configError(/dnsResolver: template must be a non-empty string/));
        assert.throws(() => dnsResolver({ template: "" }), configError(/template/));
        assert.throws(() => dnsResolver({ template: 5 as never }), configError(/template/));
        assert.throws(() => dnsResolver(undefined as never), configError(/dnsResolver/));
    });

    it("dnsResolver rejects a createTransport that is not a function", () => {
        assert.throws(() => dnsResolver({ template: "http://{name}:1", createTransport: "x" as never }), configError(/createTransport must be a function/));
    });

    it("dnsResolver accepts a template with and without placeholders", () => {
        dnsResolver({ template: "http://{shortName}.svc:50051" });
        dnsResolver({ template: "http://gateway:50051" });
    });

    it("perServiceEnvResolver rejects a map that is not an object, and a createTransport that is not a function", () => {
        assert.throws(() => perServiceEnvResolver(undefined as never), configError(/perServiceEnvResolver: map must be an object/));
        assert.throws(() => perServiceEnvResolver({}, { createTransport: 1 as never }), configError(/createTransport must be a function/));
        perServiceEnvResolver({ [StreamingService.typeName]: "STREAMING_URL" });
    });

    it("mapResolver rejects a map that is not an object", () => {
        assert.throws(() => mapResolver(undefined as never), configError(/mapResolver: map must be an object/));
        assert.throws(() => mapResolver(null as never), configError(/mapResolver/));
        mapResolver({});
    });
});
