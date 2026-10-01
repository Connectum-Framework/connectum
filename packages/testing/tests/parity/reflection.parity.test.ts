/**
 * Group 8 — gRPC Server Reflection parity.
 *
 *   8.1 one bidi reflection stream carrying every request kind
 *
 * Reflection is a protocol registered by `@connectum/reflection`, not a user
 * service, and it keeps per-stream state (files already sent). The scenario
 * runs one long stream over each transport, so a difference in the listing,
 * in the import closure, in the "already sent" bookkeeping or in an error
 * answer shows up as a structural diff.
 */

import { create, toJson } from "@bufbuild/protobuf";
import { createClient } from "@connectrpc/connect";
import { defineService } from "@connectum/core";
import { Healthcheck } from "@connectum/healthcheck";
import { Reflection } from "@connectum/reflection";
import { ServerReflection, ServerReflectionRequestSchema, ServerReflectionResponseSchema } from "../../../reflection/gen/grpc/reflection/v1/reflection_pb.js";
import { MetaSchema } from "../../../reflection/tests/fixtures/fixture/v1/common_pb.ts";
import { FixtureService } from "../../../reflection/tests/fixtures/fixture/v1/service_pb.ts";
import { transportParityTest } from "../../src/transportParityTest.ts";

const fixtureService = defineService(FixtureService, {
    get: () => create(MetaSchema, {}),
    ping: () => ({}),
});

const requests = [
    { host: "h1", messageRequest: { case: "listServices" as const, value: "" } },
    { messageRequest: { case: "fileByFilename" as const, value: "fixture/v1/service.proto" } },
    // Every import was sent by the previous answer: only the file comes back.
    { messageRequest: { case: "fileContainingSymbol" as const, value: "fixture.v1.FixtureService.Get" } },
    { messageRequest: { case: "fileContainingExtension" as const, value: { containingType: "google.protobuf.MethodOptions", extensionNumber: 50001 } } },
    { messageRequest: { case: "allExtensionNumbersOfType" as const, value: "fixture.v1.Extendable" } },
    { messageRequest: { case: "fileContainingSymbol" as const, value: "no.such.Symbol" } },
    {},
    { messageRequest: { case: "fileByFilename" as const, value: "grpc/health/v1/health.proto" } },
].map((init) => create(ServerReflectionRequestSchema, init));

// 8.1
transportParityTest("parity 8.1: a reflection stream answers identically", {
    services: [fixtureService],
    protocols: [Healthcheck(), Reflection()],
    scenario: async ({ transport }) => {
        const client = createClient(ServerReflection, transport);
        async function* send() {
            yield* requests;
        }
        const responses: unknown[] = [];
        for await (const response of client.serverReflectionInfo(send())) {
            responses.push(toJson(ServerReflectionResponseSchema, response));
        }
        // Two equally truncated streams would still compare equal.
        if (responses.length !== requests.length) {
            throw new Error(`expected ${requests.length} responses, got ${responses.length}`);
        }
        return { response: responses };
    },
});
