/**
 * How a failed call looks on the wire, checked against the published protocol text.
 *
 * A raw `node:http2` client sends the bytes itself and decodes the response with
 * code written here from the protocol documents. The ConnectRPC client and its
 * error (de)serialisers are deliberately NOT used for expectations: they are the
 * code that encodes the answer, so they cannot disagree with it.
 *
 * Protocol facts the assertions rely on, and where they come from:
 * - Connect error codes, their HTTP statuses, and the error object (`code`,
 *   `message`, `details[]` with `type` and base64 `value` WITHOUT padding):
 *   https://connectrpc.com/docs/protocol — "Error codes", "Error end stream".
 * - Connect streaming: HTTP 200; the stream ends with an envelope whose flag byte
 *   has bit 1 (0x02) set and whose JSON payload carries `error` only on failure:
 *   https://connectrpc.com/docs/protocol — "Streaming response".
 * - gRPC: `grpc-status` is the decimal code, `grpc-message` is percent-encoded
 *   (bytes %x20-%x24 and %x26-%x7E stay as they are, all others become `%XX`),
 *   `grpc-status-details-bin` is base64 of a `google.rpc.Status`:
 *   https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-HTTP2.md
 * - gRPC status code numbers: https://github.com/grpc/grpc/blob/master/doc/statuscodes.md
 * - gRPC-Web: trailers travel in a body frame whose flag byte has the most
 *   significant bit (0x80) set; a call that fails before any message may report
 *   them in the response headers instead:
 *   https://github.com/grpc/grpc/blob/master/doc/PROTOCOL-WEB.md
 */

import assert from "node:assert/strict";
import { connect, constants, type IncomingHttpHeaders } from "node:http2";
import { after, before, describe, it } from "node:test";
import { create, toBinary } from "@bufbuild/protobuf";
import { BinaryReader } from "@bufbuild/protobuf/wire";
import { DurationSchema } from "@bufbuild/protobuf/wkt";
import { Code, ConnectError } from "@connectrpc/connect";
import { defineService } from "../../src/defineService.ts";
import { createServer } from "../../src/Server.ts";
import type { ProtocolRegistration, Server } from "../../src/types.ts";
import { respondUnknownProcedure } from "../../src/unknownProcedure.ts";
import { ItemSchema, StreamingService } from "../fixtures/streaming/v1/streaming_pb.ts";

/** One row per error code: gRPC number, Connect code string, Connect HTTP status. */
const CODES = [
    { number: 1, name: "canceled", http: 499 },
    { number: 2, name: "unknown", http: 500 },
    { number: 3, name: "invalid_argument", http: 400 },
    { number: 4, name: "deadline_exceeded", http: 504 },
    { number: 5, name: "not_found", http: 404 },
    { number: 6, name: "already_exists", http: 409 },
    { number: 7, name: "permission_denied", http: 403 },
    { number: 8, name: "resource_exhausted", http: 429 },
    { number: 9, name: "failed_precondition", http: 400 },
    { number: 10, name: "aborted", http: 409 },
    { number: 11, name: "out_of_range", http: 400 },
    { number: 12, name: "unimplemented", http: 501 },
    { number: 13, name: "internal", http: 500 },
    { number: 14, name: "unavailable", http: 503 },
    { number: 15, name: "data_loss", http: 500 },
    { number: 16, name: "unauthenticated", http: 401 },
] as const;

const UNICODE_MESSAGE = "Ошибка: 100% ✓\nвторая строка";
const SECRET = "secret-token-9f3a";

/** `google.protobuf.Duration{seconds: 5}` encoded by hand: field 1, varint 5. */
const DURATION_5S = Buffer.from([0x08, 0x05]);
const DURATION_TYPE = "google.protobuf.Duration";
/** base64 of 08 05 is "CAU=": the protocol requires the padding to be omitted. */
const DURATION_5S_BASE64_UNPADDED = "CAU";

interface RawResponse {
    status: number;
    headers: IncomingHttpHeaders;
    trailers: IncomingHttpHeaders;
    body: Buffer;
}

interface Envelope {
    flags: number;
    payload: Buffer;
}

/** What the handlers do, set by each test before it sends a request. */
const behavior: { error?: unknown; yields: number } = { yields: 0 };

function failure(code: number, message: string, withDetail = false): ConnectError {
    return new ConnectError(message, code as Code, undefined, withDetail ? [{ desc: DurationSchema, value: create(DurationSchema, { seconds: 5n }) }] : undefined);
}

function rawPost(port: number, path: string, headers: Record<string, string>, body: Buffer, method = "POST"): Promise<RawResponse> {
    const session = connect(`http://127.0.0.1:${port}`);
    return new Promise<RawResponse>((resolve, reject) => {
        const request = session.request({ ":method": method, ":path": path, ...headers });
        // A server that fails to produce a response must fail the test, not hang it.
        request.setTimeout(5_000, () => {
            request.close(constants.NGHTTP2_CANCEL);
            reject(new Error(`no complete response for ${path} within 5 s`));
        });
        let status = 0;
        let responseHeaders: IncomingHttpHeaders = {};
        let trailers: IncomingHttpHeaders = {};
        const chunks: Buffer[] = [];
        request.on("response", (h) => {
            responseHeaders = h;
            status = Number(h[":status"]);
        });
        request.on("trailers", (t) => {
            trailers = t;
        });
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => resolve({ status, headers: responseHeaders, trailers, body: Buffer.concat(chunks) }));
        request.on("error", reject);
        session.on("error", reject);
        // http2 ends a GET request by itself; a second end() would fail.
        if (method !== "GET") request.end(body);
    }).finally(() => {
        session.close();
    });
}

function envelope(flags: number, payload: Buffer): Buffer {
    const prefix = Buffer.alloc(5);
    prefix.writeUInt8(flags, 0);
    prefix.writeUInt32BE(payload.length, 1);
    return Buffer.concat([prefix, payload]);
}

function readEnvelopes(body: Buffer): Envelope[] {
    const result: Envelope[] = [];
    let offset = 0;
    while (offset < body.length) {
        assert.ok(offset + 5 <= body.length, "truncated envelope prefix");
        const flags = body.readUInt8(offset);
        const length = body.readUInt32BE(offset + 1);
        assert.ok(offset + 5 + length <= body.length, "truncated envelope payload");
        result.push({ flags, payload: body.subarray(offset + 5, offset + 5 + length) });
        offset += 5 + length;
    }
    return result;
}

/** Reverses gRPC `grpc-message` encoding: `%XX` is one byte, everything else is itself; the result is UTF-8. */
function percentDecode(value: string): string {
    const bytes: number[] = [];
    for (let i = 0; i < value.length; i++) {
        if (value[i] === "%") {
            assert.match(value.slice(i + 1, i + 3), /^[0-9A-Fa-f]{2}$/, `invalid percent escape in ${JSON.stringify(value)}`);
            bytes.push(Number.parseInt(value.slice(i + 1, i + 3), 16));
            i += 2;
        } else {
            bytes.push(value.charCodeAt(i));
        }
    }
    return Buffer.from(bytes).toString("utf8");
}

/** Every character of an encoded `grpc-message` is in %x20-%x24 / %x26-%x7E, or part of a `%XX` escape. */
function assertGrpcMessageAlphabet(value: string): void {
    for (const ch of value.replace(/%[0-9A-Fa-f]{2}/g, "")) {
        const c = ch.charCodeAt(0);
        assert.ok((c >= 0x20 && c <= 0x24) || (c >= 0x26 && c <= 0x7e), `byte 0x${c.toString(16)} must be percent-encoded in grpc-message`);
    }
}

interface DecodedStatus {
    code: number;
    message: string;
    details: { typeUrl: string; value: Buffer }[];
}

/** Decodes `google.rpc.Status { int32 code = 1; string message = 2; repeated Any details = 3; }` and `Any { string type_url = 1; bytes value = 2; }`. */
function decodeStatus(bytes: Buffer): DecodedStatus {
    const status: DecodedStatus = { code: 0, message: "", details: [] };
    const reader = new BinaryReader(bytes);
    while (reader.pos < reader.len) {
        const [field, wireType] = reader.tag();
        if (field === 1) status.code = reader.int32();
        else if (field === 2) status.message = reader.string();
        else if (field === 3) {
            const any = new BinaryReader(reader.bytes());
            const detail = { typeUrl: "", value: Buffer.alloc(0) };
            while (any.pos < any.len) {
                const [anyField, anyWire] = any.tag();
                if (anyField === 1) detail.typeUrl = any.string();
                else if (anyField === 2) detail.value = Buffer.from(any.bytes());
                else any.skip(anyWire);
            }
            status.details.push(detail);
        } else reader.skip(wireType);
    }
    return status;
}

function singleHeader(value: string | string[] | undefined): string | undefined {
    return Array.isArray(value) ? value[0] : value;
}

/** gRPC-Web trailers frame body: HTTP/1-style header lines separated by CRLF. */
function parseTrailerBlock(payload: Buffer): Record<string, string> {
    const result: Record<string, string> = {};
    for (const line of payload.toString("latin1").split("\r\n")) {
        if (line === "") continue;
        const colon = line.indexOf(":");
        result[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
    }
    return result;
}

const ITEM_PATH = "/streaming.v1.StreamingService/Echo";
const SERVER_STREAM_PATH = "/streaming.v1.StreamingService/Server";

const connectUnary = { "content-type": "application/json", "connect-protocol-version": "1" };
const connectStream = { "content-type": "application/connect+json", "connect-protocol-version": "1" };
const grpc = { "content-type": "application/grpc", te: "trailers" };
const grpcWeb = { "content-type": "application/grpc-web+proto" };
const itemJson = Buffer.from(JSON.stringify({ value: "x", sequence: 1 }));
const itemProto = Buffer.from(toBinary(ItemSchema, create(ItemSchema, { value: "x", sequence: 1 })));

describe("wire errors follow the Connect and gRPC protocols", () => {
    let server: Server;
    let port = 0;

    before(async () => {
        const service = defineService(StreamingService, {
            echo: () => {
                if (behavior.error !== undefined) throw behavior.error;
                return create(ItemSchema, { value: "ok" });
            },
            async *server() {
                for (let i = 0; i < behavior.yields; i++) yield create(ItemSchema, { value: `m${i}`, sequence: i });
                if (behavior.error !== undefined) throw behavior.error;
            },
            client: async () => {
                throw new ConnectError("unused", Code.Unimplemented);
            },
            async *bidi() {},
        });
        server = createServer({ services: [service], port: 0, host: "127.0.0.1", allowHTTP1: false });
        await server.start();
        port = server.address?.port ?? 0;
        assert.ok(port > 0, "server must bind a port");
    });

    after(async () => {
        if (server.state === "running") await server.stop();
    });

    describe("Connect unary", () => {
        for (const code of CODES) {
            it(`code ${code.name} answers HTTP ${code.http} with a JSON error object`, async () => {
                behavior.error = failure(code.number, `msg-${code.name}`);
                const res = await rawPost(port, ITEM_PATH, connectUnary, itemJson);
                assert.equal(res.status, code.http);
                assert.match(singleHeader(res.headers["content-type"]) ?? "", /^application\/json/);
                assert.deepEqual(JSON.parse(res.body.toString("utf8")), { code: code.name, message: `msg-${code.name}` });
            });
        }

        it("carries a non-ASCII message intact", async () => {
            behavior.error = failure(3, UNICODE_MESSAGE);
            const res = await rawPost(port, ITEM_PATH, connectUnary, itemJson);
            assert.equal(JSON.parse(res.body.toString("utf8")).message, UNICODE_MESSAGE);
        });

        it("encodes a detail as its full type name and unpadded base64", async () => {
            behavior.error = failure(3, "with detail", true);
            const res = await rawPost(port, ITEM_PATH, connectUnary, itemJson);
            const body = JSON.parse(res.body.toString("utf8"));
            assert.equal(body.details.length, 1);
            assert.equal(body.details[0].type, DURATION_TYPE);
            assert.equal(body.details[0].value, DURATION_5S_BASE64_UNPADDED);
            assert.equal(Buffer.from(body.details[0].value, "base64").equals(DURATION_5S), true);
        });

        it("reports a plain Error as internal without its text anywhere in the response", async () => {
            behavior.error = new Error(SECRET);
            const res = await rawPost(port, ITEM_PATH, connectUnary, itemJson);
            assert.equal(res.status, 500);
            assert.equal(JSON.parse(res.body.toString("utf8")).code, "internal");
            assert.equal(res.body.toString("utf8").includes(SECRET), false);
            assert.equal(JSON.stringify(res.headers).includes(SECRET), false);
        });
    });

    describe("Connect streaming", () => {
        it("ends a failed stream with an end-of-stream envelope carrying the error", async () => {
            behavior.error = failure(5, "gone");
            behavior.yields = 2;
            const res = await rawPost(port, SERVER_STREAM_PATH, connectStream, envelope(0, itemJson));
            assert.equal(res.status, 200);
            assert.match(singleHeader(res.headers["content-type"]) ?? "", /^application\/connect\+json/);
            const frames = readEnvelopes(res.body);
            assert.equal(frames.length, 3);
            assert.deepEqual(
                frames.map((f) => f.flags),
                [0x00, 0x00, 0x02],
            );
            assert.deepEqual(JSON.parse(frames[2]?.payload.toString("utf8") ?? ""), { error: { code: "not_found", message: "gone" } });
        });

        it("ends a successful stream with an end-of-stream envelope without an error field", async () => {
            behavior.error = undefined;
            behavior.yields = 2;
            const res = await rawPost(port, SERVER_STREAM_PATH, connectStream, envelope(0, itemJson));
            assert.equal(res.status, 200);
            const frames = readEnvelopes(res.body);
            assert.equal(frames.length, 3);
            const last = frames[2];
            assert.equal(last?.flags, 0x02);
            assert.equal("error" in JSON.parse(last?.payload.toString("utf8") ?? "{}"), false);
        });

        it("reports a plain Error mid-stream as internal without its text", async () => {
            behavior.error = new Error(SECRET);
            behavior.yields = 1;
            const res = await rawPost(port, SERVER_STREAM_PATH, connectStream, envelope(0, itemJson));
            const frames = readEnvelopes(res.body);
            const last = frames[frames.length - 1];
            assert.equal(last?.flags, 0x02);
            assert.equal(JSON.parse(last?.payload.toString("utf8") ?? "").error.code, "internal");
            assert.equal(res.body.toString("utf8").includes(SECRET), false);
        });
    });

    describe("gRPC", () => {
        for (const code of CODES) {
            it(`code ${code.name} is grpc-status ${code.number}`, async () => {
                behavior.error = failure(code.number, `msg-${code.name}`);
                const res = await rawPost(port, ITEM_PATH, grpc, envelope(0, itemProto));
                assert.equal(res.status, 200);
                const source = res.trailers["grpc-status"] !== undefined ? res.trailers : res.headers;
                assert.equal(singleHeader(source["grpc-status"]), String(code.number));
                assert.equal(percentDecode(singleHeader(source["grpc-message"]) ?? ""), `msg-${code.name}`);
            });
        }

        it("sends no message body for a failure before any message and reports the status in headers or trailers", async () => {
            behavior.error = failure(3, "early");
            const res = await rawPost(port, ITEM_PATH, grpc, envelope(0, itemProto));
            assert.equal(res.body.length, 0);
            assert.equal(singleHeader(res.headers["grpc-status"]) ?? singleHeader(res.trailers["grpc-status"]), "3");
        });

        it("percent-encodes the message and decodes back to the original UTF-8", async () => {
            behavior.error = failure(3, UNICODE_MESSAGE);
            const res = await rawPost(port, ITEM_PATH, grpc, envelope(0, itemProto));
            const source = res.trailers["grpc-message"] !== undefined ? res.trailers : res.headers;
            const encoded = singleHeader(source["grpc-message"]) ?? "";
            assertGrpcMessageAlphabet(encoded);
            assert.equal(percentDecode(encoded), UNICODE_MESSAGE);
        });

        it("carries code, message and detail in grpc-status-details-bin", async () => {
            behavior.error = failure(3, "with detail", true);
            const res = await rawPost(port, ITEM_PATH, grpc, envelope(0, itemProto));
            const source = res.trailers["grpc-status-details-bin"] !== undefined ? res.trailers : res.headers;
            const raw = singleHeader(source["grpc-status-details-bin"]);
            assert.ok(raw, "grpc-status-details-bin must be present when the error has a detail");
            const status = decodeStatus(Buffer.from(raw, "base64"));
            assert.equal(status.code, 3);
            assert.equal(status.message, "with detail");
            assert.equal(status.details.length, 1);
            assert.equal(status.details[0]?.typeUrl.split("/").pop(), DURATION_TYPE);
            assert.equal(status.details[0]?.value.equals(DURATION_5S), true);
        });

        it("reports success as status 0 without details", async () => {
            behavior.error = undefined;
            const res = await rawPost(port, ITEM_PATH, grpc, envelope(0, itemProto));
            const source = res.trailers["grpc-status"] !== undefined ? res.trailers : res.headers;
            assert.equal(singleHeader(source["grpc-status"]), "0");
            assert.equal(source["grpc-status-details-bin"], undefined);
        });

        it("reports a plain Error as internal (13) without its text", async () => {
            behavior.error = new Error(SECRET);
            const res = await rawPost(port, ITEM_PATH, grpc, envelope(0, itemProto));
            const source = res.trailers["grpc-status"] !== undefined ? res.trailers : res.headers;
            assert.equal(singleHeader(source["grpc-status"]), "13");
            assert.equal(JSON.stringify({ h: res.headers, t: res.trailers }).includes(SECRET), false);
        });
    });

    describe("gRPC-Web", () => {
        it("reports a failure after a message in a trailers frame", async () => {
            behavior.error = failure(5, UNICODE_MESSAGE);
            behavior.yields = 1;
            const res = await rawPost(port, SERVER_STREAM_PATH, grpcWeb, envelope(0, itemProto));
            assert.equal(res.status, 200);
            const frames = readEnvelopes(res.body);
            assert.equal(frames.length, 2);
            assert.equal(frames[0]?.flags, 0x00);
            assert.equal((frames[1]?.flags ?? 0) & 0x80, 0x80, "last frame must be a trailers frame");
            const trailers = parseTrailerBlock(frames[1]?.payload ?? Buffer.alloc(0));
            assert.equal(trailers["grpc-status"], "5");
            assertGrpcMessageAlphabet(trailers["grpc-message"] ?? "");
            assert.equal(percentDecode(trailers["grpc-message"] ?? ""), UNICODE_MESSAGE);
        });

        it("reports a failure before any message in the headers or in a trailers frame", async () => {
            behavior.error = failure(3, "early");
            behavior.yields = 0;
            const res = await rawPost(port, ITEM_PATH, grpcWeb, envelope(0, itemProto));
            const frames = readEnvelopes(res.body);
            const trailerFrame = frames.find((f) => (f.flags & 0x80) === 0x80);
            const fromFrame = trailerFrame ? parseTrailerBlock(trailerFrame.payload) : {};
            const status = singleHeader(res.headers["grpc-status"]) ?? fromFrame["grpc-status"];
            assert.equal(status, "3");
        });

        it("carries the detail in grpc-status-details-bin", async () => {
            behavior.error = failure(3, "with detail", true);
            behavior.yields = 0;
            const res = await rawPost(port, ITEM_PATH, grpcWeb, envelope(0, itemProto));
            const trailerFrame = readEnvelopes(res.body).find((f) => (f.flags & 0x80) === 0x80);
            const fromFrame = trailerFrame ? parseTrailerBlock(trailerFrame.payload) : {};
            const raw = singleHeader(res.headers["grpc-status-details-bin"]) ?? fromFrame["grpc-status-details-bin"];
            assert.ok(raw, "grpc-status-details-bin must be present when the error has a detail");
            const status = decodeStatus(Buffer.from(raw, "base64"));
            assert.equal(status.code, 3);
            assert.equal(status.details[0]?.value.equals(DURATION_5S), true);
        });
    });
});

/**
 * What a client that follows the protocols concludes from a response. When the
 * response carries the protocol's own status it is used; otherwise the protocols
 * prescribe an inference from the HTTP status (Connect: "HTTP to Error Code"
 * table; gRPC: http-grpc-status-mapping.md, "only for clients that received a
 * response that did not include grpc-status").
 */
function clientReadsCode(res: RawResponse, protocol: "connect" | "grpc" | "grpc-web"): string {
    if (protocol === "connect") {
        const contentType = singleHeader(res.headers["content-type"]) ?? "";
        if (contentType.startsWith("application/json")) {
            try {
                const body = JSON.parse(res.body.toString("utf8"));
                if (typeof body.code === "string") return body.code;
            } catch {
                // malformed error body: the protocol says to infer from the HTTP status
            }
        }
    } else {
        // The body is length-prefixed frames only when the response is itself a gRPC response.
        const isGrpcBody = (singleHeader(res.headers["content-type"]) ?? "").startsWith("application/grpc");
        const trailerFrame = isGrpcBody ? readEnvelopes(res.body).find((f) => (f.flags & 0x80) === 0x80) : undefined;
        const fromFrame = trailerFrame ? parseTrailerBlock(trailerFrame.payload) : {};
        const status = singleHeader(res.headers["grpc-status"]) ?? singleHeader(res.trailers["grpc-status"]) ?? fromFrame["grpc-status"];
        if (status !== undefined) return CODES.find((c) => String(c.number) === status)?.name ?? "unknown";
    }
    const inferred: Record<number, string> = {
        400: "internal",
        401: "unauthenticated",
        403: "permission_denied",
        404: "unimplemented",
        429: "unavailable",
        502: "unavailable",
        503: "unavailable",
        504: "unavailable",
    };
    return inferred[res.status] ?? "unknown";
}

const UNKNOWN_PATH = "/streaming.v1.StreamingService/NoSuchMethod";
const UNKNOWN_SERVICE_PATH = "/nosuch.v1.NoService/Echo";
const NOT_FOUND_PREFIX = "procedure not found: ";

/** Statuses and trailers a gRPC response carries, wherever it put them (headers for Trailers-Only, trailers otherwise). */
function grpcStatusOf(res: RawResponse): { status: string | undefined; message: string | undefined } {
    const source = res.headers["grpc-status"] !== undefined ? res.headers : res.trailers;
    return { status: singleHeader(source["grpc-status"]), message: singleHeader(source["grpc-message"]) };
}

describe("a call to an unknown procedure is answered in the protocol of the request", () => {
    let server: Server;
    let port = 0;

    before(async () => {
        const service = defineService(StreamingService, {
            echo: () => {
                if (behavior.error !== undefined) throw behavior.error;
                return create(ItemSchema, { value: "ok" });
            },
            async *server() {
                if (behavior.error !== undefined) throw behavior.error;
            },
            client: async () => {
                throw new ConnectError("unused", Code.Unimplemented);
            },
            async *bidi() {},
        });
        const claimed: ProtocolRegistration = {
            name: "claims-a-procedure-shaped-path",
            register: () => {},
            httpHandler: (req, res) => {
                if (req.url !== "/claimed.v1.Thing/Get") return false;
                res.statusCode = 204;
                res.end();
                return true;
            },
        };
        server = createServer({ services: [service], port: 0, host: "127.0.0.1", allowHTTP1: false, protocols: [claimed] });
        await server.start();
        port = server.address?.port ?? 0;
    });

    after(async () => {
        if (server.state === "running") await server.stop();
    });

    for (const path of [UNKNOWN_PATH, UNKNOWN_SERVICE_PATH]) {
        describe(path, () => {
            it("Connect unary: HTTP 501 and a JSON error whose code is unimplemented", async () => {
                const res = await rawPost(port, path, connectUnary, itemJson);
                assert.equal(res.status, 501);
                assert.match(singleHeader(res.headers["content-type"]) ?? "", /^application\/json/);
                assert.deepEqual(JSON.parse(res.body.toString("utf8")), { code: "unimplemented", message: `${NOT_FOUND_PREFIX}${path}` });
                assert.equal(clientReadsCode(res, "connect"), "unimplemented");
            });

            it("Connect streaming: HTTP 200 with a single end-of-stream envelope carrying the error", async () => {
                const res = await rawPost(port, path, connectStream, envelope(0, itemJson));
                assert.equal(res.status, 200);
                assert.equal(singleHeader(res.headers["content-type"]), "application/connect+json");
                const frames = readEnvelopes(res.body);
                assert.equal(frames.length, 1);
                assert.equal(frames[0]?.flags, 0x02);
                assert.deepEqual(JSON.parse(frames[0]?.payload.toString("utf8") ?? ""), { error: { code: "unimplemented", message: `${NOT_FOUND_PREFIX}${path}` } });
            });

            it("gRPC: grpc-status 12, the path in a percent-encoded grpc-message and no body", async () => {
                const res = await rawPost(port, path, grpc, envelope(0, itemProto));
                assert.equal(res.status, 200);
                assert.match(singleHeader(res.headers["content-type"]) ?? "", /^application\/grpc/);
                const { status, message } = grpcStatusOf(res);
                assert.equal(status, "12");
                assertGrpcMessageAlphabet(message ?? "");
                assert.equal(percentDecode(message ?? ""), `${NOT_FOUND_PREFIX}${path}`);
                assert.equal(res.body.length, 0);
                assert.equal(clientReadsCode(res, "grpc"), "unimplemented");
            });

            it("gRPC-Web: a single trailers frame carrying grpc-status 12", async () => {
                const res = await rawPost(port, path, grpcWeb, envelope(0, itemProto));
                assert.equal(res.status, 200);
                assert.equal(singleHeader(res.headers["content-type"]), "application/grpc-web+proto");
                const frames = readEnvelopes(res.body);
                assert.equal(frames.length, 1);
                assert.equal(frames[0]?.flags, 0x80);
                const trailers = parseTrailerBlock(frames[0]?.payload ?? Buffer.alloc(0));
                assert.equal(trailers["grpc-status"], "12");
                assertGrpcMessageAlphabet(trailers["grpc-message"] ?? "");
                assert.equal(percentDecode(trailers["grpc-message"] ?? ""), `${NOT_FOUND_PREFIX}${path}`);
                assert.equal(clientReadsCode(res, "grpc-web"), "unimplemented");
            });
        });
    }

    describe("matches what a handler that throws unimplemented sends", () => {
        const thrown = (): void => {
            behavior.error = failure(12, "thrown");
        };

        it("Connect unary: same HTTP status, content type and error code", async () => {
            thrown();
            const real = await rawPost(port, ITEM_PATH, connectUnary, itemJson);
            const unknown = await rawPost(port, UNKNOWN_PATH, connectUnary, itemJson);
            assert.equal(unknown.status, real.status);
            assert.equal(singleHeader(unknown.headers["content-type"]), singleHeader(real.headers["content-type"]));
            assert.equal(JSON.parse(unknown.body.toString("utf8")).code, JSON.parse(real.body.toString("utf8")).code);
        });

        it("Connect streaming: same end-of-stream flag and error code", async () => {
            thrown();
            const real = readEnvelopes((await rawPost(port, SERVER_STREAM_PATH, connectStream, envelope(0, itemJson))).body);
            const unknown = readEnvelopes((await rawPost(port, UNKNOWN_PATH, connectStream, envelope(0, itemJson))).body);
            assert.equal(unknown.at(-1)?.flags, real.at(-1)?.flags);
            assert.equal(JSON.parse(unknown.at(-1)?.payload.toString("utf8") ?? "").error.code, JSON.parse(real.at(-1)?.payload.toString("utf8") ?? "").error.code);
        });

        it("gRPC: same grpc-status", async () => {
            thrown();
            const real = grpcStatusOf(await rawPost(port, ITEM_PATH, grpc, envelope(0, itemProto)));
            const unknown = grpcStatusOf(await rawPost(port, UNKNOWN_PATH, grpc, envelope(0, itemProto)));
            assert.equal(unknown.status, real.status);
        });

        it("gRPC-Web: same grpc-status in a trailers frame", async () => {
            thrown();
            const trailersOf = (res: RawResponse) => {
                const frame = readEnvelopes(res.body).find((f) => (f.flags & 0x80) === 0x80);
                return parseTrailerBlock(frame?.payload ?? Buffer.alloc(0))["grpc-status"];
            };
            const real = trailersOf(await rawPost(port, ITEM_PATH, grpcWeb, envelope(0, itemProto)));
            const unknown = trailersOf(await rawPost(port, UNKNOWN_PATH, grpcWeb, envelope(0, itemProto)));
            assert.equal(unknown, real);
        });
    });

    describe("the requested path cannot alter or inflate the response", () => {
        it("keeps at most 200 characters of a long path", async () => {
            const long = `/svc/${"a".repeat(5_000)}`;
            const res = await rawPost(port, long, connectUnary, itemJson);
            const message: string = JSON.parse(res.body.toString("utf8")).message;
            assert.equal(message.startsWith(`${NOT_FOUND_PREFIX}/svc/aaa`), true);
            assert.ok(message.length < 300, `message must stay bounded, got ${message.length} characters`);
        });

        it("percent-encodes a path that imitates header or trailer lines in grpc-message", async () => {
            const hostile = "/svc/%0D%0Agrpc-status:%200";
            const viaGrpc = await rawPost(port, hostile, grpc, envelope(0, itemProto));
            const grpcResult = grpcStatusOf(viaGrpc);
            assert.equal(grpcResult.status, "12");
            assertGrpcMessageAlphabet(grpcResult.message ?? "");
            assert.equal(percentDecode(grpcResult.message ?? ""), `${NOT_FOUND_PREFIX}${hostile}`);

            const viaWeb = await rawPost(port, hostile, grpcWeb, envelope(0, itemProto));
            const frames = readEnvelopes(viaWeb.body);
            assert.equal(frames.length, 1);
            const trailers = parseTrailerBlock(frames[0]?.payload ?? Buffer.alloc(0));
            assert.deepEqual(Object.keys(trailers).sort(), ["grpc-message", "grpc-status"]);
            assert.equal(trailers["grpc-status"], "12");
        });
    });

    describe("requests that are not served RPC calls keep the plain 404", () => {
        const plain404 = (res: RawResponse): void => {
            assert.equal(res.status, 404);
            assert.equal(res.body.toString("utf8"), "Not Found");
        };

        it("GET to an unknown path", async () => {
            plain404(await rawPost(port, "/nothing-here", {}, Buffer.alloc(0), "GET"));
        });

        it("GET to a procedure-shaped path (Connect GET unary is not served)", async () => {
            plain404(await rawPost(port, `${UNKNOWN_PATH}?encoding=json&message=%7B%7D`, { "connect-protocol-version": "1" }, Buffer.alloc(0), "GET"));
        });

        it("GET that carries the content type of a served protocol", async () => {
            for (const contentType of ["application/json", "application/grpc", "application/grpc-web+proto"]) {
                plain404(await rawPost(port, UNKNOWN_PATH, { "content-type": contentType }, Buffer.alloc(0), "GET"));
            }
        });

        it("POST with a content type of no served protocol", async () => {
            plain404(await rawPost(port, UNKNOWN_PATH, { "content-type": "text/plain" }, Buffer.from("x")));
        });

        it("POST without a content type", async () => {
            plain404(await rawPost(port, UNKNOWN_PATH, {}, Buffer.from("x")));
        });

        it("grpc-web-text, which the server does not serve", async () => {
            plain404(await rawPost(port, UNKNOWN_PATH, { "content-type": "application/grpc-web-text" }, Buffer.from("x")));
        });

        for (const path of ["/", "/onlyone", "/a/b/c", "/a//"]) {
            it(`a path that is not /<service>/<method>: ${path}`, async () => {
                plain404(await rawPost(port, path, connectUnary, itemJson));
            });
        }
    });

    it("a protocol HTTP handler answers a procedure-shaped path before the unknown-procedure response", async () => {
        const res = await rawPost(port, "/claimed.v1.Thing/Get", connectUnary, itemJson);
        assert.equal(res.status, 204);
    });

    it("a served method is not mistaken for unknown", async () => {
        behavior.error = undefined;
        const res = await rawPost(port, ITEM_PATH, connectUnary, itemJson);
        assert.equal(res.status, 200);
        assert.deepEqual(JSON.parse(res.body.toString("utf8")), { value: "ok" });
    });
});

describe("the unknown-procedure message is encoded byte by byte", () => {
    function capture(url: string, contentType: string): { handled: boolean; status: number; headers: Record<string, unknown>; body: Buffer } {
        const out = { status: 0, headers: {} as Record<string, unknown>, chunks: [] as Buffer[] };
        const res = {
            set statusCode(status: number) {
                out.status = status;
            },
            setHeader(name: string, value: unknown) {
                out.headers[name] = value;
            },
            end(chunk?: Buffer) {
                if (chunk) out.chunks.push(chunk);
            },
        };
        const handled = respondUnknownProcedure({ method: "POST", url, headers: { "content-type": contentType } } as never, res as never);
        return { handled, status: out.status, headers: out.headers, body: Buffer.concat(out.chunks) };
    }

    it("turns non-ASCII characters of the path into UTF-8 percent escapes in grpc-message", () => {
        const result = capture("/svc/Ош", "application/grpc");
        const message = String(result.headers["grpc-message"]);
        assertGrpcMessageAlphabet(message);
        assert.equal(message, "procedure not found: /svc/%D0%9E%D1%88");
        assert.equal(percentDecode(message), `${NOT_FOUND_PREFIX}/svc/Ош`);
    });

    it("answers JSON and proto variants of every protocol with the matching content type", () => {
        const cases: [string, string][] = [
            ["application/grpc+json", "application/grpc+json"],
            ["application/grpc", "application/grpc+proto"],
            ["application/grpc-web+json", "application/grpc-web+json"],
            ["application/grpc-web", "application/grpc-web+proto"],
            ["application/connect+proto", "application/connect+proto"],
            ["application/connect+json; charset=utf-8", "application/connect+json"],
        ];
        for (const [requested, answered] of cases) {
            const result = capture("/svc/m", requested);
            assert.equal(result.handled, true, requested);
            assert.equal(result.headers["content-type"], answered, requested);
        }
    });

    it("leaves a request that is not an RPC call untouched", () => {
        const result = capture("/svc/m", "text/plain");
        assert.equal(result.handled, false);
        assert.equal(result.status, 0);
    });
});


describe("the protocol oracle rejects deviating encodings", () => {
    it("grpc-message with a raw non-ASCII byte is rejected", () => {
        assert.throws(() => assertGrpcMessageAlphabet("Ошибка"));
    });

    it("grpc-message with a raw percent sign is rejected, an escaped one is accepted", () => {
        assert.throws(() => assertGrpcMessageAlphabet("100%"));
        assertGrpcMessageAlphabet("100%25");
    });

    it("an invalid percent escape is rejected while decoding", () => {
        assert.throws(() => percentDecode("bad%zz"));
    });

    it("percent decoding yields UTF-8 from multi-byte escapes", () => {
        assert.equal(percentDecode("%D0%9E%D1%88"), "Ош");
    });

    it("the padded form of the detail value differs from the unpadded one the protocol requires", () => {
        assert.notEqual(DURATION_5S.toString("base64"), DURATION_5S_BASE64_UNPADDED);
        assert.equal(DURATION_5S.toString("base64").replace(/=+$/, ""), DURATION_5S_BASE64_UNPADDED);
    });

    it("a trailers frame is told apart from a data frame by the flag's top bit", () => {
        const frames = readEnvelopes(Buffer.concat([envelope(0x00, Buffer.from("a")), envelope(0x80, Buffer.from("grpc-status: 0\r\n"))]));
        assert.deepEqual(
            frames.map((f) => (f.flags & 0x80) === 0x80),
            [false, true],
        );
        assert.deepEqual(parseTrailerBlock(frames[1]?.payload ?? Buffer.alloc(0)), { "grpc-status": "0" });
    });
});
