/**
 * Answer to an RPC call for a procedure the server does not serve.
 *
 * The Connect and gRPC protocols leave this case open and tell a client to read
 * an HTTP 404 as `unimplemented`, so a bare 404 is already understood. Encoding
 * the error in the protocol of the request gives every client the error it
 * expects: a JSON error object, an end-of-stream envelope, or a gRPC status.
 *
 * The encoding is written out here, from the protocol text, instead of calling
 * the encoders of `@connectrpc/connect`: those are marked `@private` (no semver
 * guarantee) and `@connectrpc/connect` is a peer dependency, so a consumer's
 * minor update could change them. The surface is one code and one message.
 *
 * @module unknownProcedure
 */

import type { NodeRequest, NodeResponse } from "./types.ts";

const CODE = "unimplemented";
const GRPC_STATUS_UNIMPLEMENTED = "12";
const HTTP_STATUS_UNIMPLEMENTED = 501;
const MAX_PATH_CHARS = 200;

const END_STREAM_FLAG = 0x02;
const TRAILERS_FLAG = 0x80;

const CONNECT_UNARY = /^application\/(?:json(?:; ?charset=utf-?8)?|proto)$/i;
const CONNECT_STREAM = /^application\/connect\+(?:json(?:; ?charset=utf-?8)?|proto)$/i;
const GRPC = /^application\/grpc(?:\+(?:json(?:; ?charset=utf-?8)?|proto))?$/i;
const GRPC_WEB = /^application\/grpc-web(?:\+(?:json(?:; ?charset=utf-?8)?|proto))?$/i;

const PROCEDURE_PATH = /^\/[^/]+\/[^/]+$/;

function isJson(contentType: string): boolean {
    return /json/i.test(contentType);
}

function messageFor(path: string): string {
    const shown = path.length > MAX_PATH_CHARS ? `${path.slice(0, MAX_PATH_CHARS)}...` : path;
    return `procedure not found: ${shown}`;
}

/** gRPC `grpc-message` value: bytes outside 0x20-0x7E and `%` become `%XX`. */
function percentEncode(message: string): string {
    let encoded = "";
    for (const byte of Buffer.from(message, "utf8")) {
        const plain = byte >= 0x20 && byte <= 0x7e && byte !== 0x25;
        encoded += plain ? String.fromCharCode(byte) : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
    }
    return encoded;
}

function envelope(flags: number, data: Buffer): Buffer {
    const framed = Buffer.alloc(5 + data.byteLength);
    framed.writeUInt8(flags, 0);
    framed.writeUInt32BE(data.byteLength, 1);
    data.copy(framed, 5);
    return framed;
}

/** `writeHead` has different overloads on HTTP/1 and HTTP/2 responses; these members are shared. */
function send(res: NodeResponse, status: number, headers: Record<string, string>, body?: Buffer): void {
    res.statusCode = status;
    for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value);
    }
    if (body === undefined) {
        res.end();
    } else {
        res.end(body);
    }
}

/**
 * Answer a call to an unknown procedure in the encoding of the request's
 * protocol.
 *
 * @returns `true` when the request was an RPC call of a served protocol and has
 *   been answered; `false` when it is anything else and nothing was written.
 */
export function respondUnknownProcedure(req: NodeRequest, res: NodeResponse): boolean {
    if (req.method !== "POST") {
        return false;
    }
    const path = (req.url ?? "").split("?", 1)[0] ?? "";
    if (!PROCEDURE_PATH.test(path)) {
        return false;
    }
    const contentType = req.headers["content-type"];
    if (typeof contentType !== "string") {
        return false;
    }
    const message = messageFor(path);

    if (CONNECT_UNARY.test(contentType)) {
        send(res, HTTP_STATUS_UNIMPLEMENTED, { "content-type": "application/json" }, Buffer.from(JSON.stringify({ code: CODE, message })));
        return true;
    }
    if (CONNECT_STREAM.test(contentType)) {
        const end = envelope(END_STREAM_FLAG, Buffer.from(JSON.stringify({ error: { code: CODE, message } })));
        send(res, 200, { "content-type": isJson(contentType) ? "application/connect+json" : "application/connect+proto" }, end);
        return true;
    }
    if (GRPC.test(contentType)) {
        send(res, 200, {
            "content-type": isJson(contentType) ? "application/grpc+json" : "application/grpc+proto",
            "grpc-status": GRPC_STATUS_UNIMPLEMENTED,
            "grpc-message": percentEncode(message),
        });
        return true;
    }
    if (GRPC_WEB.test(contentType)) {
        const trailers = `grpc-status: ${GRPC_STATUS_UNIMPLEMENTED}\r\ngrpc-message: ${percentEncode(message)}\r\n`;
        send(
            res,
            200,
            { "content-type": isJson(contentType) ? "application/grpc-web+json" : "application/grpc-web+proto" },
            envelope(TRAILERS_FLAG, Buffer.from(trailers, "utf8")),
        );
        return true;
    }
    return false;
}
