/**
 * Integration tests for gRPC Health Check protocol
 *
 * Tests the full healthcheck flow:
 * 1. Start a real server with @connectum/healthcheck protocol
 * 2. Use ConnectRPC client to call Health.Check / Health.List
 * 3. Verify gRPC error codes, status transitions, and HTTP health endpoints
 * 4. Stop the server
 *
 * Transport: createGrpcTransport (HTTP/2, required for streaming).
 *
 * NOTE: When `services: []` is passed, the Healthcheck's setup() calls
 * manager.initialize(serviceNames) where serviceNames comes from
 * context.registry which has no files from user services. The Health service's
 * own DescFile is registered only after setup() runs, so the manager starts
 * with 0 tracked services.
 *
 * To test status tracking, we call manager.initialize() with a fake service
 * AFTER server start (so it doesn't get wiped by the protocol's own initialize).
 */

import assert from "node:assert";
import http from "node:http";
import net from "node:net";
import { after, before, describe, it } from "node:test";
import { Code, ConnectError, createClient } from "@connectrpc/connect";
import { createGrpcTransport } from "@connectrpc/connect-node";
import type { Server } from "@connectum/core";
import { createServer } from "@connectum/core";
import { Health } from "../../gen/grpc/health/v1/health_pb.js";
import { Healthcheck } from "../../src/Healthcheck.ts";
import { createHealthcheckManager } from "../../src/HealthcheckManager.ts";
import { ServingStatus } from "../../src/types.ts";

/**
 * Make an HTTP/1.1 GET request to a local port and return status code,
 * headers and body.
 */
function httpGetFrom(port: number, path: string): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
    return new Promise((resolve, reject) => {
        const req = http.get(`http://localhost:${port}${path}`, (res) => {
            let data = "";
            res.on("data", (chunk: string) => {
                data += chunk;
            });
            res.on("end", () => {
                resolve({ statusCode: res.statusCode ?? 0, headers: res.headers, body: data });
            });
        });
        req.on("error", reject);
        req.end();
    });
}

/**
 * Fake service name used to simulate a real application scenario.
 * In production, this would be populated from the proto DescFile registry.
 */
const FAKE_SERVICE = "test.v1.TestService";

describe("Healthcheck gRPC Integration", () => {
    let server: Server;
    let serverUrl: string;
    let manager: ReturnType<typeof createHealthcheckManager>;

    before(async () => {
        // Use an isolated manager so tests don't pollute the singleton.
        manager = createHealthcheckManager();

        server = createServer({
            services: [],
            port: 0,
            protocols: [Healthcheck({ httpEnabled: true, manager })],
            interceptors: [],
            allowHTTP1: false,
        });

        await server.start();
        const port = server.address?.port;
        assert.ok(port, "Server should have an assigned port");
        serverUrl = `http://localhost:${port}`;

        // Initialize the manager with a fake service AFTER server start.
        // Healthcheck's setup() already called initialize([]) with empty
        // service names (no user services). We re-initialize to simulate
        // having a real user service.
        manager.initialize([FAKE_SERVICE]);
    });

    after(async () => {
        if (server?.isRunning) {
            await server.stop();
        }
    });

    it("should return overall health via Health.Check with empty service name", async () => {
        const transport = createGrpcTransport({ baseUrl: serverUrl });
        const client = createClient(Health, transport);

        // Service starts in UNKNOWN state, areAllHealthy() returns false
        const response = await client.check({ service: "" });

        assert.ok(response, "Should return a response");
        assert.strictEqual(
            response.status,
            ServingStatus.NOT_SERVING,
            "Overall should be NOT_SERVING when services are in UNKNOWN state",
        );
    });

    it("should return correct status for a specific registered service", async () => {
        const transport = createGrpcTransport({ baseUrl: serverUrl });
        const client = createClient(Health, transport);

        // Update the fake service to SERVING
        manager.update(ServingStatus.SERVING, FAKE_SERVICE);

        const response = await client.check({ service: FAKE_SERVICE });
        assert.strictEqual(
            response.status,
            ServingStatus.SERVING,
            "Specific service should reflect SERVING status",
        );
    });

    it("should throw NotFound for unknown service name", async () => {
        const transport = createGrpcTransport({ baseUrl: serverUrl });
        const client = createClient(Health, transport);

        try {
            await client.check({ service: "nonexistent.v1.FakeService" });
            assert.fail("Expected ConnectError with Code.NotFound");
        } catch (err) {
            assert.ok(err instanceof ConnectError, `Expected ConnectError, got ${err}`);
            assert.strictEqual(
                err.code,
                Code.NotFound,
                `Expected NotFound code, got ${Code[err.code]}`,
            );
        }
    });

    it("should reflect status change from NOT_SERVING to SERVING", async () => {
        const transport = createGrpcTransport({ baseUrl: serverUrl });
        const client = createClient(Health, transport);

        // Set all services to NOT_SERVING
        manager.update(ServingStatus.NOT_SERVING);

        // Verify overall is NOT_SERVING
        const responseBefore = await client.check({ service: "" });
        assert.strictEqual(
            responseBefore.status,
            ServingStatus.NOT_SERVING,
            "Overall should be NOT_SERVING before update",
        );

        // Update all services to SERVING
        manager.update(ServingStatus.SERVING);

        // Verify overall now returns SERVING
        const responseAfter = await client.check({ service: "" });
        assert.strictEqual(
            responseAfter.status,
            ServingStatus.SERVING,
            "Overall should be SERVING after update",
        );
    });

    // grpc.health.v1 List returns a map of every tracked service name to its
    // current status. The case sets a distinct status per entry (services and a
    // component), so a response that lists the right names with wrong statuses,
    // or with every status collapsed to one value, fails.
    it("should list every tracked entry with its own current status via Health.List", async () => {
        const otherService = "test.v1.OtherService";
        const client = createClient(Health, createGrpcTransport({ baseUrl: serverUrl }));

        manager.initialize([FAKE_SERVICE, otherService]);
        manager.update(ServingStatus.SERVING, FAKE_SERVICE);
        manager.update(ServingStatus.NOT_SERVING, otherService);
        manager.register("worker");
        try {
            const response = await client.list({});

            assert.deepStrictEqual(
                Object.fromEntries(Object.entries(response.statuses).map(([name, entry]) => [name, entry.status])),
                {
                    [FAKE_SERVICE]: ServingStatus.SERVING,
                    [otherService]: ServingStatus.NOT_SERVING,
                    worker: ServingStatus.UNKNOWN,
                },
            );
        } finally {
            manager.unregister("worker");
            manager.initialize([FAKE_SERVICE]);
        }
    });
});

describe("Healthcheck HTTP Integration", () => {
    let server: Server;
    let port: number;
    let manager: ReturnType<typeof createHealthcheckManager>;

    before(async () => {
        manager = createHealthcheckManager();

        server = createServer({
            services: [],
            port: 0,
            protocols: [Healthcheck({ httpEnabled: true, manager })],
            interceptors: [],
            // Need allowHTTP1 for HTTP/1.1 health endpoint testing
            allowHTTP1: true,
        });

        await server.start();
        const assignedPort = server.address?.port;
        assert.ok(assignedPort, "Server should have an assigned port");
        port = assignedPort;

        // Initialize after server start (same reason as gRPC tests above)
        manager.initialize([FAKE_SERVICE]);
    });

    after(async () => {
        if (server?.isRunning) {
            await server.stop();
        }
    });

    /**
     * Helper to make an HTTP/1.1 GET request and return status code + body.
     */
    function httpGet(path: string) {
        return httpGetFrom(port, path);
    }

    it("should return 503 when services are not healthy", async () => {
        // Services are initialized in UNKNOWN state -> NOT healthy
        const { statusCode, body } = await httpGet("/healthz");

        assert.strictEqual(statusCode, 503, "Should return 503 for unhealthy state");

        const parsed = JSON.parse(body);
        assert.strictEqual(parsed.status, "NOT_SERVING");
        assert.strictEqual(parsed.service, "overall");
    });

    it("should return 200 when all services are healthy", async () => {
        // Update all services to SERVING
        manager.update(ServingStatus.SERVING);

        const { statusCode, body } = await httpGet("/healthz");

        assert.strictEqual(statusCode, 200, "Should return 200 for healthy state");

        const parsed = JSON.parse(body);
        assert.strictEqual(parsed.status, "SERVING");
        assert.strictEqual(parsed.service, "overall");
    });

    // The documented response is a JSON body {status, service, timestamp}; on
    // the wire that means the application/json media type and an ISO-8601 UTC
    // timestamp of the moment of the request.
    it("should answer with a JSON content type and the current UTC timestamp", async () => {
        manager.update(ServingStatus.SERVING);

        const before = Date.now();
        const { headers, body } = await httpGet("/healthz");
        const after = Date.now();

        assert.strictEqual(headers["content-type"]?.split(";")[0]?.trim().toLowerCase(), "application/json");

        const parsed = JSON.parse(body);
        assert.deepStrictEqual(Object.keys(parsed).sort(), ["service", "status", "timestamp"]);
        assert.match(parsed.timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        const instant = Date.parse(parsed.timestamp);
        assert.ok(instant >= before && instant <= after, `timestamp ${parsed.timestamp} must lie within the request window [${before}, ${after}]`);
    });

    it("should respond on /health path as well", async () => {
        manager.update(ServingStatus.SERVING);

        const { statusCode } = await httpGet("/health");
        assert.strictEqual(statusCode, 200, "Should respond on /health path");
    });

    it("should respond on /readyz path as well", async () => {
        manager.update(ServingStatus.SERVING);

        const { statusCode } = await httpGet("/readyz");
        assert.strictEqual(statusCode, 200, "Should respond on /readyz path");
    });

    it("should return 404 for unknown service via HTTP health endpoint", async () => {
        const { statusCode, body } = await httpGet("/healthz?service=unknown.v1.Unknown");

        assert.strictEqual(statusCode, 404, "Should return 404 for unknown service");

        const parsed = JSON.parse(body);
        assert.strictEqual(parsed.status, "SERVICE_UNKNOWN");
    });

    it("should transition from 503 to 200 when health improves", async () => {
        // Set NOT_SERVING
        manager.update(ServingStatus.NOT_SERVING);

        const unhealthy = await httpGet("/healthz");
        assert.strictEqual(unhealthy.statusCode, 503, "Should be 503 for NOT_SERVING");

        // Set SERVING
        manager.update(ServingStatus.SERVING);

        const healthy = await httpGet("/healthz");
        assert.strictEqual(healthy.statusCode, 200, "Should be 200 for SERVING");
    });
});

describe("Healthcheck HTTP endpoints are opt-in", () => {
    let server: Server;
    let port: number;
    let manager: ReturnType<typeof createHealthcheckManager>;

    before(async () => {
        manager = createHealthcheckManager();
        manager.register("process", ServingStatus.SERVING);

        // No httpEnabled option at all: the documented default is off.
        server = createServer({
            services: [],
            port: 0,
            protocols: [Healthcheck({ manager })],
            interceptors: [],
            allowHTTP1: true,
        });
        await server.start();
        assert.ok(server.address?.port);
        port = server.address.port;
    });

    after(async () => {
        if (server?.isRunning) {
            await server.stop();
        }
    });

    it("serves no HTTP health endpoint when httpEnabled is not given", async () => {
        for (const path of ["/healthz", "/health", "/readyz"]) {
            const { statusCode, body } = await httpGetFrom(port, path);

            assert.strictEqual(statusCode, 404, `${path} must not be served`);
            assert.doesNotMatch(body, /"timestamp"/, `${path} must not return a health payload`);
        }
    });
});

describe("Healthcheck HTTP custom httpPaths", () => {
    let server: Server;
    let port: number;

    before(async () => {
        const manager = createHealthcheckManager();
        manager.register("process", ServingStatus.SERVING);

        server = createServer({
            services: [],
            port: 0,
            protocols: [Healthcheck({ httpEnabled: true, httpPaths: ["/custom-health"], manager })],
            interceptors: [],
            allowHTTP1: true,
        });
        await server.start();
        assert.ok(server.address?.port);
        port = server.address.port;
    });

    after(async () => {
        if (server?.isRunning) {
            await server.stop();
        }
    });

    it("answers on the configured path and on none of the default paths", async () => {
        const configured = await httpGetFrom(port, "/custom-health");
        assert.strictEqual(configured.statusCode, 200);
        assert.strictEqual(JSON.parse(configured.body).status, "SERVING");

        for (const path of ["/healthz", "/health", "/readyz"]) {
            const { statusCode, body } = await httpGetFrom(port, path);
            assert.strictEqual(statusCode, 404, `${path} must no longer be served`);
            assert.doesNotMatch(body, /"timestamp"/, `${path} must not return a health payload`);
        }
    });

    it("matches the path exactly: a trailing slash or another case is not served", async () => {
        for (const path of ["/custom-health/", "/Custom-Health"]) {
            const { statusCode, body } = await httpGetFrom(port, path);
            assert.strictEqual(statusCode, 404, `${path} must not be served`);
            assert.doesNotMatch(body, /"timestamp"/, `${path} must not return a health payload`);
        }
    });

    it("ignores the query string when matching the path", async () => {
        const { statusCode, body } = await httpGetFrom(port, "/custom-health?x=1");
        assert.strictEqual(statusCode, 200);
        assert.strictEqual(JSON.parse(body).status, "SERVING");
    });
});

/**
 * Send one HTTP/1.1 request over a bare TCP socket, so the Host header can be
 * empty or malformed, which `http.get` refuses to produce.
 */
function rawHttp1Get(port: number, target: string, hostHeader: string): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolve, reject) => {
        const socket = net.connect(port, "127.0.0.1");
        let raw = "";
        socket.setEncoding("utf8");
        socket.on("connect", () => {
            socket.write(`GET ${target} HTTP/1.1\r\nHost:${hostHeader}\r\nConnection: close\r\n\r\n`);
        });
        socket.on("data", (chunk: string) => {
            raw += chunk;
        });
        socket.on("error", reject);
        socket.on("close", () => {
            const [head = "", ...rest] = raw.split("\r\n\r\n");
            const statusCode = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
            resolve({ statusCode, body: rest.join("\r\n\r\n") });
        });
    });
}

describe("Healthcheck HTTP service query with a degenerate Host header", () => {
    let server: Server;
    let port: number;

    before(async () => {
        const manager = createHealthcheckManager();
        // The named service is healthy while the process as a whole is not, so
        // an answer about the whole process cannot be mistaken for the answer
        // about the named service.
        manager.register("named", ServingStatus.SERVING);
        manager.register("broken", ServingStatus.NOT_SERVING);

        server = createServer({
            services: [],
            port: 0,
            protocols: [Healthcheck({ httpEnabled: true, manager })],
            interceptors: [],
            allowHTTP1: true,
        });
        await server.start();
        assert.ok(server.address?.port);
        port = server.address.port;
    });

    after(async () => {
        if (server?.isRunning) {
            await server.stop();
        }
    });

    it("sanity: a well-formed Host answers about the named service", async () => {
        const { statusCode, body } = await rawHttp1Get(port, "/healthz?service=named", ` 127.0.0.1:${port}`);
        assert.strictEqual(statusCode, 200);
        assert.deepStrictEqual({ status: JSON.parse(body).status, service: JSON.parse(body).service }, { status: "SERVING", service: "named" });
    });

    for (const [desc, hostHeader] of [
        ["an empty Host", ""],
        ["a syntactically invalid Host", " bad host"],
    ] as const) {
        it(`answers about the named service with ${desc}`, async () => {
            const { statusCode, body } = await rawHttp1Get(port, "/healthz?service=named", hostHeader);
            const parsed = JSON.parse(body);

            assert.strictEqual(statusCode, 200, "the named service is SERVING; the overall state would be 503");
            assert.strictEqual(parsed.status, "SERVING");
            assert.strictEqual(parsed.service, "named");
        });

        it(`answers 404 for an unknown service with ${desc}`, async () => {
            const { statusCode, body } = await rawHttp1Get(port, "/healthz?service=missing.Svc", hostHeader);
            const parsed = JSON.parse(body);

            assert.strictEqual(statusCode, 404);
            assert.strictEqual(parsed.status, "SERVICE_UNKNOWN");
            assert.strictEqual(parsed.service, "missing.Svc");
        });
    }

    it("reports the overall state for an empty service value", async () => {
        const { statusCode, body } = await rawHttp1Get(port, "/healthz?service=", ` 127.0.0.1:${port}`);
        assert.strictEqual(statusCode, 503, "the overall state is NOT_SERVING while 'broken' is");
        assert.strictEqual(JSON.parse(body).status, "NOT_SERVING");
    });
});
