/**
 * Type definitions for @connectum/testing.
 *
 * @module
 */

import type { DescMessage } from "@bufbuild/protobuf";

// ============================================================
// Mock Request
// ============================================================

/** Options for {@link createMockRequest}. */
export interface MockRequestOptions {
    /** Service type name. Default: `'test.TestService'` */
    service?: string;
    /** Method name. Default: `'TestMethod'` */
    method?: string;
    /** Request message payload. Default: `{}` */
    message?: unknown;
    /** Streaming request flag. Default: `false` */
    stream?: boolean;
    /** Request URL. Auto-generated from service/method if omitted. */
    url?: string;
    /** Request headers. Default: `new Headers()` */
    headers?: Headers;
}

// ============================================================
// Mock Next
// ============================================================

/** Options for {@link createMockNext} and {@link createMockNextSlow}. */
export interface MockNextOptions {
    /** Response message. Default: `{ result: 'success' }` */
    message?: unknown;
    /** Streaming response flag. Default: `false` */
    stream?: boolean;
}

// ============================================================
// Mock Protobuf Descriptors
// ============================================================

/** Options for {@link createMockDescMessage}. */
export interface MockDescMessageOptions {
    /** Field definitions. Default: `[]` */
    fields?: Array<{
        name: string;
        type?: string;
        fieldNumber?: number;
    }>;
    /** Oneof group names. Default: `[]` */
    oneofs?: string[];
}

/** Options for {@link createMockDescField}. */
export interface MockDescFieldOptions {
    /** Mark field as sensitive (for redact interceptor). Default: `false` */
    isSensitive?: boolean;
    /** Proto field number. Default: auto-incremented */
    fieldNumber?: number;
    /** Field scalar type. Default: `'string'` */
    type?: string;
}

/** Options for {@link createMockDescMethod}. */
export interface MockDescMethodOptions {
    /** Input message descriptor. */
    input?: DescMessage;
    /** Output message descriptor. */
    output?: DescMessage;
    /** Method kind. Default: `'unary'` */
    kind?: "unary" | "server_streaming" | "client_streaming" | "bidi_streaming";
    /** Enable sensitive field redaction for this method. Default: `false` */
    useSensitiveRedaction?: boolean;
}

// ============================================================
// Mock Stream
// ============================================================

/** Options for {@link createMockStream}. */
export interface MockStreamOptions {
    /** Delay in milliseconds between yielded items. */
    delayMs?: number;
}

// ============================================================
// Fake Service / Method
// ============================================================

/** Options for {@link createFakeService}. */
export interface FakeServiceOptions {
    /** Service type name. Default: `'test.v1.TestService'` */
    typeName?: string;
    /** Service name (short). Default: derived from typeName */
    name?: string;
}

/** Options for {@link createFakeMethod}. */
export interface FakeMethodOptions {
    /** Method kind. Default: `'unary'` */
    methodKind?: "unary" | "server_streaming" | "client_streaming" | "bidi_streaming";
    /** Whether to register the method in service.methods. Default: `false` */
    register?: boolean;
}

// ============================================================
// Test Server
// ============================================================

/** A running test server with transport and cleanup. */
export interface TestServer {
    /** Pre-configured client transport connected to the test server. */
    transport: import("@connectrpc/connect").Transport;
    /** Server base URL (e.g. `http://localhost:54321`). */
    baseUrl: string;
    /** Assigned port number. */
    port: number;
    /** Stop the server and close all connections. */
    close(): Promise<void>;
}

/** Options for {@link createTestServer}. */
export interface CreateTestServerOptions {
    /** ConnectRPC service route handlers. */
    services: unknown[];
    /** Interceptors to apply. Default: `[]` */
    interceptors?: unknown[];
    /** Protocol extensions (Healthcheck, Reflection). Default: `[]` */
    protocols?: unknown[];
    /** Port number. Default: `0` (random available port) */
    port?: number;
}
