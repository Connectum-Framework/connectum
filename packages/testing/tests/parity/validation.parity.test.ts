/**
 * Proto-declared validation parity, on the shipped validation interceptor.
 *
 * The server chain is `createDefaultInterceptors()` from `@connectum/interceptors`
 * (validation is on by default and is `@connectrpc/validate`), and the rules are
 * real `buf.validate` annotations in `tests/fixtures/validated`. Nothing in this
 * file imitates the interceptor: a test that drove a stand-in would stay green
 * while the shipped interceptor changed its wire behaviour.
 *
 * Oracle. A violation reaches the client as `ConnectError.details`: one
 * `buf.validate.Violations` message, never a header or trailer. The scenarios
 * therefore compare the detail bytes (base64) between the transports AND decode
 * them into (field path, rule id, message) triples that are checked against
 * literals. Field paths and rule ids are the documented protovalidate contract;
 * the message texts are those of @bufbuild/protovalidate, so a library upgrade
 * that rewords them fails here on purpose. Agreement between the two transports
 * alone would also pass if both dropped the details.
 */

import assert from "node:assert";
import { test as nodeTest } from "node:test";
import { create, fromBinary } from "@bufbuild/protobuf";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createLocalTransport, createServer, defineService } from "@connectum/core";
// biome-ignore lint/correctness/useImportExtensions: bare package specifier
import { createDefaultInterceptors } from "@connectum/interceptors";
import { defaultCompare, type ParityScenarioResult, transportParityTest } from "../../src/transportParityTest.ts";
import { type Violations, ViolationsSchema } from "../fixtures/validated/pb/buf/validate/validate_pb.ts";
import { CountSchema, EchoRequestSchema, EchoResponseSchema, ItemSchema, ValidatedService } from "../fixtures/validated/pb/validated/v1/validated_pb.ts";

/** One violation, reduced to what a client acts on. */
interface DecodedViolation {
    field: string;
    ruleId: string;
    message: string;
}

const VIOLATIONS_TYPE = ViolationsSchema.typeName;

function decodeViolations(violations: Violations): DecodedViolation[] {
    return violations.violations.map((violation) => ({
        field: (violation.field?.elements ?? []).map((element) => element.fieldName ?? "").join("."),
        ruleId: violation.ruleId ?? "",
        message: violation.message ?? "",
    }));
}

/**
 * Reports a rejection the way a client sees it: code, text, the raw detail
 * entries (type + base64 of the wire bytes) and the decoded violations.
 */
function describeRejection(err: unknown): NonNullable<ParityScenarioResult["error"]> {
    if (!(err instanceof ConnectError)) {
        return { code: "non-connect", message: String(err) };
    }
    const rawDetails = err.details.map((detail) => {
        if ("desc" in detail) {
            throw new Error(`detail ${detail.desc.typeName} arrived as an outgoing detail; a client receives only wire details`);
        }
        return { type: detail.type, base64: Buffer.from(detail.value).toString("base64") };
    });
    const violationDetails = rawDetails.filter((detail) => detail.type === VIOLATIONS_TYPE);
    const decoded = violationDetails.flatMap((detail) => decodeViolations(fromBinary(ViolationsSchema, Buffer.from(detail.base64, "base64"))));
    return { code: err.code, message: err.rawMessage, details: { raw: rawDetails, violations: decoded } };
}

/**
 * Error oracle shared by the rejection scenarios: both transports reject with
 * InvalidArgument, carry exactly one `buf.validate.Violations` detail whose
 * decoded content equals `expected`, and the whole error is byte-for-byte equal.
 */
function expectViolationsOnBothTransports(expected: DecodedViolation[]) {
    return (http: ParityScenarioResult, local: ParityScenarioResult): void => {
        for (const [name, result] of [
            ["HTTP", http],
            ["local", local],
        ] as const) {
            assert.ok(result.error, `${name} transport must surface an error`);
            assert.strictEqual(result.error.code, Code.InvalidArgument, `${name} transport must reject with InvalidArgument`);
            const details = result.error.details as { raw: Array<{ type: string }>; violations: DecodedViolation[] };
            assert.deepStrictEqual(
                details.raw.map((detail) => detail.type),
                [VIOLATIONS_TYPE],
                `${name} transport must deliver exactly one ${VIOLATIONS_TYPE} detail`,
            );
            assert.deepStrictEqual(details.violations, expected, `${name} transport must deliver the documented violations`);
        }
        defaultCompare(http, local);
    };
}

function validatedRoutes() {
    return defineService(ValidatedService, {
        echo: (req) => create(EchoResponseSchema, { message: `ok:${req.message}` }),
        async collect(requests) {
            let total = 0;
            for await (const _ of requests) total++;
            return create(CountSchema, { total });
        },
    });
}

/**
 * The shipped chain with validation left at its default (on). Only the error
 * logging is silenced: every rejection here is expected and would otherwise
 * print a stack trace per run.
 */
function shippedChain() {
    return createDefaultInterceptors({ errorHandler: { logErrors: false } });
}

transportParityTest("parity: valid request passes the shipped validation on both transports", {
    services: [validatedRoutes()],
    interceptors: shippedChain(),
    scenario: async ({ transport }) => {
        const client = createClient(ValidatedService, transport);
        const res = await client.echo(create(EchoRequestSchema, { message: "hello", count: 1 }));
        return { response: { message: res.message } };
    },
    // The handler's answer for a valid request, not merely agreement between the transports.
    compare: (http, local) => {
        assert.deepStrictEqual(http.response, { message: "ok:hello" }, "HTTP transport must deliver the handler's response");
        assert.deepStrictEqual(local.response, { message: "ok:hello" }, "Local transport must deliver the handler's response");
        defaultCompare(http, local);
    },
});

transportParityTest("parity: single-rule violation carries identical buf.validate details on both transports", {
    services: [validatedRoutes()],
    interceptors: shippedChain(),
    scenario: async ({ transport }) => {
        const client = createClient(ValidatedService, transport);
        try {
            await client.echo(create(EchoRequestSchema, { message: "" }));
            throw new Error("expected validation to reject the empty message, but the call succeeded");
        } catch (err) {
            return { error: describeRejection(err) };
        }
    },
    compare: expectViolationsOnBothTransports([{ field: "message", ruleId: "string.min_len", message: "must be at least 3 characters" }]),
});

transportParityTest("parity: multi-rule violation lists every broken rule in the same order on both transports", {
    services: [validatedRoutes()],
    interceptors: shippedChain(),
    scenario: async ({ transport }) => {
        const client = createClient(ValidatedService, transport);
        try {
            // 51 characters containing "bad" breaks max_len and not_contains on one field,
            // and the negative count breaks the rule of a second field.
            await client.echo(create(EchoRequestSchema, { message: `bad${"x".repeat(48)}`, count: -1 }));
            throw new Error("expected validation to reject the request, but the call succeeded");
        } catch (err) {
            return { error: describeRejection(err) };
        }
    },
    compare: expectViolationsOnBothTransports([
        { field: "message", ruleId: "string.max_len", message: "must be at most 50 characters" },
        { field: "message", ruleId: "string.not_contains", message: "contains substring `bad`" },
        { field: "count", ruleId: "int32.gte", message: "must be greater than or equal to 0" },
    ]),
});

transportParityTest("parity: client-streaming mid-stream violation carries identical details on both transports", {
    services: [validatedRoutes()],
    interceptors: shippedChain(),
    scenario: async ({ transport }) => {
        const client = createClient(ValidatedService, transport);
        async function* messages() {
            yield create(ItemSchema, { value: "ok" });
            yield create(ItemSchema, { value: "" });
        }
        try {
            const res = await client.collect(messages());
            throw new Error(`expected streaming validation to reject the empty item, but the call returned total=${res.total}`);
        } catch (err) {
            return { error: describeRejection(err) };
        }
    },
    compare: expectViolationsOnBothTransports([{ field: "value", ruleId: "string.min_len", message: "must be at least 1 characters" }]),
});

// The only documented way into a handler in-process is `createLocalTransport(server)`,
// which runs the same server interceptors as HTTP. An invalid request through it must
// still be rejected, and a valid one still served, so the rejection comes from the rule.
nodeTest("parity: local transport has no validation-bypass API", async () => {
    const server = createServer({ services: [validatedRoutes()], interceptors: shippedChain() });
    const client = createClient(ValidatedService, createLocalTransport(server));
    await assert.rejects(client.echo(create(EchoRequestSchema, { message: "" })), (err: unknown) => {
        assert.ok(err instanceof ConnectError, "expected a ConnectError");
        assert.strictEqual(err.code, Code.InvalidArgument, "local transport must surface InvalidArgument");
        assert.deepStrictEqual(
            decodeViolations(err.findDetails(ViolationsSchema)[0] as Violations).map((violation) => violation.ruleId),
            ["string.min_len"],
            "the violation must reach the client as a buf.validate detail",
        );
        return true;
    });

    const ok = await client.echo(create(EchoRequestSchema, { message: "hello" }));
    assert.strictEqual(ok.message, "ok:hello");
});

/**
 * Fallback enabled next to validation. A request that breaks a rule is a client error
 * and must reach the caller as `InvalidArgument` with the violations, not as a served
 * response. The handler fails for a valid request in the second scenario, so the
 * fallback demonstrably still works and the first scenario is not passing because the
 * fallback is inert.
 */
function fallbackChain() {
    return createDefaultInterceptors({
        errorHandler: { logErrors: false },
        fallback: { handler: () => create(EchoResponseSchema, { message: "FALLBACK" }) },
    });
}

function failingRoutes() {
    return defineService(ValidatedService, {
        echo: () => {
            throw new ConnectError("dependency down", Code.Unavailable);
        },
        collect: async () => create(CountSchema, { total: 0 }),
    });
}

transportParityTest("parity: fallback does not replace a validation rejection on either transport", {
    services: [failingRoutes()],
    interceptors: fallbackChain(),
    scenario: async ({ transport }) => {
        const client = createClient(ValidatedService, transport);
        try {
            const res = await client.echo(create(EchoRequestSchema, { message: "" }));
            throw new Error(`expected validation to reject the empty message, but the call returned "${res.message}"`);
        } catch (err) {
            return { error: describeRejection(err) };
        }
    },
    compare: expectViolationsOnBothTransports([{ field: "message", ruleId: "string.min_len", message: "must be at least 3 characters" }]),
});

transportParityTest("parity: fallback still answers a failing handler for a valid request on both transports", {
    services: [failingRoutes()],
    interceptors: fallbackChain(),
    scenario: async ({ transport }) => {
        const client = createClient(ValidatedService, transport);
        const res = await client.echo(create(EchoRequestSchema, { message: "hello" }));
        return { response: { message: res.message } };
    },
    compare: (http, local) => {
        assert.deepStrictEqual(http.response, { message: "FALLBACK" }, "HTTP transport must deliver the fallback value");
        assert.deepStrictEqual(local.response, { message: "FALLBACK" }, "Local transport must deliver the fallback value");
        defaultCompare(http, local);
    },
});
