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
 * NOTE: When `services: []` is passed, the Healthcheck's register() calls
 * manager.initialize(serviceNames) where serviceNames comes from
 * context.registry which has no files from user services. The Health service's
 * own DescFile is added to the registry only after initialize() is called,
 * so the manager starts with 0 tracked services.
 *
 * To test status tracking, we call manager.initialize() with a fake service
 * AFTER server start (so it doesn't get wiped by the protocol's own initialize).
 */

import assert from "node:assert";
import http from "node:http";
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
        // Healthcheck's register() already called initialize([]) with empty
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

    it("should list all services via Health.List", async () => {
        const transport = createGrpcTransport({ baseUrl: serverUrl });
        const client = createClient(Health, transport);

        const response = await client.list({});

        assert.ok(response, "Should return a list response");
        assert.ok(response.statuses, "Should have statuses map");

        // The statuses map should contain our fake service
        const serviceNames = Object.keys(response.statuses);
        assert.ok(serviceNames.length > 0, "Should have at least one service in the list");
        assert.ok(
            serviceNames.includes(FAKE_SERVICE),
            `Expected ${FAKE_SERVICE} in statuses, got: ${JSON.stringify(serviceNames)}`,
        );
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
    function httpGet(path: string): Promise<{ statusCode: number; body: string }> {
        return new Promise((resolve, reject) => {
            const req = http.get(`http://localhost:${port}${path}`, (res) => {
                let data = "";
                res.on("data", (chunk: string) => {
                    data += chunk;
                });
                res.on("end", () => {
                    resolve({ statusCode: res.statusCode ?? 0, body: data });
                });
            });
            req.on("error", reject);
            req.end();
        });
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
